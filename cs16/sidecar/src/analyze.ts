/**
 * Reads a compare.sh run directory (one `<brain>.jsonl` per brain) and prints
 * a markdown report: outcomes with confidence intervals and significance
 * tests, then what each brain chose in each situation and how those rounds
 * went.
 *
 *   pnpm exec tsx cs16/sidecar/src/analyze.ts cs16/runs/<stamp>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { NOOP_ID } from '@xstate/jev';
import { ruleChoice, type Situation } from './brains';

type Line =
  | { t: 'meta'; brain: string; [k: string]: unknown }
  | { t: 'round_start'; round: number; at: number; route?: 'left' | 'right' | null; cue?: 'true' | 'hidden' | 'flipped' }
  | { t: 'round_end'; round: number; result: 'win' | 'loss' | 'draw'; at: number }
  | { t: 'death'; round: number; who: 'bot' | 'enemy' }
  | { t: 'move'; round: number; at: number; from: string; to: string; fired: boolean }
  | {
      t: 'decision';
      round: number;
      at: number;
      ms: number;
      situation: Situation | null;
      options: string[];
      choice: string | null;
      confidence: number;
      cached: boolean;
      sent: boolean;
    };
type Decision = Extract<Line, { t: 'decision' }> & { situation: Situation; choice: string; result: 'win' | 'loss' | 'draw' };
type Move = Extract<Line, { t: 'move' }>;

export interface BrainRun {
  brain: string;
  meta: Record<string, unknown>;
  rounds: Array<{
    round: number;
    slot: string;
    /** 1-based position within its block (one sidecar run). */
    index: number;
    /** Seconds from round start to the first peek; null if it never peeked. */
    firstPeekS: number | null;
    result: 'win' | 'loss' | 'draw';
    seconds: number;
    route?: 'left' | 'right' | null;
    /** How the side cue was corrupted this round, when it was. */
    cue?: 'true' | 'hidden' | 'flipped';
  }>;
  decisions: Decision[];
  moves: Move[];
}

/** How soon after the answer a state change still counts as its consequence. */
const NEXT_MOVE_MS = 1500;
/** A first peek this soon counts as peeking at once (matches bot.ts). */
const AT_ONCE_S = 1.5;
/** Rounds at the start of a block, before memory has anything to say. */
const EARLY_ROUNDS = 3;

// ------------------------------------------------------------------ maths

/** Wilson score interval for a binomial proportion; z = 1.96 for 95%. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const logFact = (() => {
  const cache = [0];
  return (n: number) => {
    for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1] + Math.log(i);
    return cache[n];
  };
})();

/** Two-sided Fisher exact test on [[a, b], [c, d]]: p of a table at least this extreme. */
export function fisher(a: number, b: number, c: number, d: number): number {
  const r1 = a + b;
  const r2 = c + d;
  const c1 = a + c;
  const n = r1 + r2;
  const pOf = (x: number) =>
    Math.exp(logFact(r1) + logFact(r2) + logFact(c1) + logFact(n - c1) - logFact(n) - logFact(x) - logFact(r1 - x) - logFact(c1 - x) - logFact(r2 - c1 + x));
  const observed = pOf(a);
  let p = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) {
    const px = pOf(x);
    if (px <= observed * (1 + 1e-7)) p += px;
  }
  return Math.min(1, p);
}

/** Cohen's h: effect size between two proportions. ~0.2 small, ~0.5 medium, ~0.8 large. */
export const cohenH = (p1: number, p2: number) => 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2));

/** Rounds per brain to detect p1 vs p2 at alpha 0.05 (two-sided) with 80% power. */
export function roundsNeeded(p1: number, p2: number): number {
  const h = Math.abs(cohenH(p1, p2));
  return h === 0 ? Infinity : Math.ceil(2 * ((1.96 + 0.8416) / h) ** 2);
}

/** Two-proportion z (pooled), positive when A wins more. */
export function twoPropZ(wA: number, nA: number, wB: number, nB: number): number {
  const p = (wA + wB) / (nA + nB);
  const se = Math.sqrt(p * (1 - p) * (1 / nA + 1 / nB));
  return se === 0 ? 0 : (wA / nA - wB / nB) / se;
}

const normalCdf = (x: number) => {
  // Abramowitz-Stegun 26.2.17, |error| < 7.5e-8.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - q : q;
};

/**
 * Chance of ending significant (two-sided 0.05) at the cap if the trend so far
 * holds, from z at information fraction t (rounds so far / cap).
 */
export function conditionalPower(z: number, t: number): number {
  if (t >= 1) return Math.abs(z) >= 1.96 ? 1 : 0;
  return normalCdf((Math.abs(z) / Math.sqrt(t) - 1.96) / Math.sqrt(1 - t));
}

/** The pre-registered stopping rule: Haybittle-Peto efficacy, non-binding futility on conditional power. */
export function sequentialLook(z: number, t: number): 'efficacy' | 'futility' | 'continue' | 'final: significant' | 'final: not significant' {
  if (t >= 1) return Math.abs(z) >= 1.96 ? 'final: significant' : 'final: not significant';
  if (Math.abs(z) >= 3.29) return 'efficacy';
  if (conditionalPower(z, t) < 0.1) return 'futility';
  return 'continue';
}

// ------------------------------------------------------------------ reading

/** `offset` keeps round numbers from different files apart once merged. */
export function readRun(path: string, offset = 0): BrainRun {
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
  // A second meta line means two runs appended to one file (a reused RUN_DIR): their round numbers collide and the later run silently overwrites the earlier one.
  if (lines.filter((l) => l.t === 'meta').length > 1) throw new Error(`${path} holds more than one run (several meta lines); give each run its own RUN_DIR`);
  const meta = (lines.find((l) => l.t === 'meta') ?? { brain: basename(path, '.jsonl') }) as Record<string, unknown>;
  const starts = new Map<number, number>();
  const routes = new Map<number, 'left' | 'right' | null>();
  const cues = new Map<number, 'true' | 'hidden' | 'flipped'>();
  const results = new Map<number, { result: 'win' | 'loss' | 'draw'; seconds: number }>();
  for (const l of lines) {
    if (l.t === 'round_start') {
      starts.set(l.round, l.at);
      routes.set(l.round, l.route ?? null);
      if (l.cue) cues.set(l.round, l.cue);
    }
    if (l.t === 'round_end') results.set(l.round, { result: l.result, seconds: (l.at - (starts.get(l.round) ?? l.at)) / 1000 });
  }
  // Only rounds the duel scored: free-play round starts never get a round_end.
  const decisions = lines
    .filter((l): l is Extract<Line, { t: 'decision' }> => l.t === 'decision' && results.has(l.round) && !!l.situation && !!l.choice)
    .map((d) => ({ ...d, round: d.round + offset, result: results.get(d.round)!.result }) as Decision);
  const slot = meta.slot === undefined ? '-' : String(meta.slot);
  const firstPeek = (round: number) => {
    const m = lines.find((l): l is Move => l.t === 'move' && l.round === round && l.to.startsWith('peeking'));
    return m && starts.has(round) ? (m.at - starts.get(round)!) / 1000 : null;
  };
  return {
    brain: String(meta.brain),
    meta,
    rounds: [...results].map(([round, r], i) => ({ round: round + offset, slot, index: i + 1, firstPeekS: firstPeek(round), route: routes.get(round) ?? null, cue: cues.get(round), ...r })),
    decisions,
    moves: lines.filter((l): l is Move => l.t === 'move' && results.has(l.round)).map((m) => ({ ...m, round: m.round + offset })),
  };
}

/** One run per brain: a balanced comparison logs each brain once per slot. */
export function mergeRuns(runs: BrainRun[]): BrainRun[] {
  const byBrain = new Map<string, BrainRun>();
  for (const r of runs) {
    const into = byBrain.get(r.brain);
    if (!into) byBrain.set(r.brain, { ...r, rounds: [...r.rounds], decisions: [...r.decisions], moves: [...r.moves] });
    else {
      into.rounds.push(...r.rounds);
      into.decisions.push(...r.decisions);
      into.moves.push(...r.moves);
    }
  }
  return [...byBrain.values()];
}

// ------------------------------------------------------------------ report

const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const short = (id: string) => (id === NOOP_ID ? 'wait' : id.replace('enemy.', ''));

/** The situation as a coarse bucket: where the bot is, whether it sees the attacker, and its aim. */
export function bucket(s: Situation): string {
  const aim = s.aim === 'settled, your best shot' ? 'aim settled' : s.aim === 'half settled, a rushed shot' ? 'aim half' : s.aim === 'still settling, no shot yet' ? 'aim settling' : 'no aim';
  if (s.you === 'holding') {
    const cue = s.footstepsHeard ? 'footsteps' : s.secondsSincePlayerSeen === 'never seen this round' ? 'not seen yet' : 'seen before';
    return `holding · ${cue}`;
  }
  return `${s.you} · ${s.playerInSight ? 'in sight' : 'not in sight'}${s.playerInSight ? ` · ${aim}` : ''}`;
}

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function report(runs: BrainRun[]): string {
  const out: string[] = [];
  const meta = runs[0]?.meta ?? {};
  out.push('# Brain comparison', '');
  out.push(
    `Body: ${meta.enemy_weapon && meta.enemy_weapon !== meta.weapon ? `${meta.weapon} for Jev's bot, ${meta.enemy_weapon} for the zBot` : `${meta.weapon} both sides`}, ` +
      `turn ${meta.turn}°/s, scope ${meta.scope}, preaim ${meta.preaim}${meta.dirty ? ' (uncommitted changes in the tree)' : ''}. ` +
      `Opponent: zBot difficulty ${meta.difficulty}${meta.zhold ? ', holding its position' : ''}. Plugin ${meta.plugin}, git ${meta.git}.`,
    '',
  );

  out.push('## Outcomes', '');
  out.push(
    table(
      ['brain', 'rounds', 'W-L-D', 'win rate', '95% CI', 'median round', 'decisions/round'],
      runs.map((r) => {
        const n = r.rounds.length;
        const w = r.rounds.filter((x) => x.result === 'win').length;
        const l = r.rounds.filter((x) => x.result === 'loss').length;
        const [lo, hi] = wilson(w, n);
        const secs = r.rounds.map((x) => x.seconds).sort((a, b) => a - b);
        return [
          r.brain,
          String(n),
          `${w}-${l}-${n - w - l}`,
          n ? pct(w / n) : '-',
          `${pct(lo)}–${pct(hi)}`,
          secs.length ? `${secs[Math.floor(secs.length / 2)].toFixed(1)}s` : '-',
          n ? (r.decisions.length / n).toFixed(1) : '-',
        ];
      }),
    ),
    '',
  );

  const slots = [...new Set(runs.flatMap((r) => r.rounds.map((x) => x.slot)))].sort();
  if (slots.length > 1) {
    out.push('## By slot', '');
    out.push('Wins-losses per brain on each server. A balanced run gives every brain every slot.', '');
    out.push(
      table(
        ['brain', ...slots.map((s) => `slot ${s}`)],
        runs.map((r) => [
          r.brain,
          ...slots.map((s) => {
            const here = r.rounds.filter((x) => x.slot === s);
            return here.length ? `${here.filter((x) => x.result === 'win').length}-${here.filter((x) => x.result === 'loss').length}` : '-';
          }),
        ]),
      ),
      '',
    );
  }

  const hasRoutes = runs.some((r) => r.rounds.some((x) => x.route));
  if (hasRoutes) {
    out.push('## By zBot route', '');
    out.push('Wins-losses-draws split by the route logged at round start.', '');
    out.push(
      table(
        ['brain', 'left route', 'right route'],
        runs.map((r) => [
          r.brain,
          ...(['left', 'right'] as const).map((route) => {
            const here = r.rounds.filter((x) => x.route === route);
            if (!here.length) return '-';
            const w = here.filter((x) => x.result === 'win').length;
            const l = here.filter((x) => x.result === 'loss').length;
            return `${w}-${l}-${here.length - w - l}`;
          }),
        ]),
      ),
      '',
    );

    if (runs.some((r) => r.rounds.some((x) => x.cue))) {
      out.push('## By cue condition', '');
      out.push('Wins-losses-draws by how the side cue was corrupted that round (true, hidden, or pointing at the wrong lane).', '');
      out.push(
        table(
          ['brain', 'true', 'hidden', 'flipped'],
          runs.map((r) => [
            r.brain,
            ...(['true', 'hidden', 'flipped'] as const).map((cue) => {
              const here = r.rounds.filter((x) => x.cue === cue);
              if (!here.length) return '-';
              const w = here.filter((x) => x.result === 'win').length;
              const l = here.filter((x) => x.result === 'loss').length;
              return `${w}-${l}-${here.length - w - l}`;
            }),
          ]),
        ),
        '',
      );
    }

    out.push('## Split opening', '');
    out.push('Wrong-side first peeks count rounds where the first delivered peek chose the lane opposite the zBot route.', '');
    out.push(
      table(
        ['brain', 'first left', 'first right', 'wrong side'],
        runs.map((r) => {
          let left = 0, right = 0, wrong = 0, withRoute = 0;
          for (const round of r.rounds) {
            const first = r.moves.find((m) => m.round === round.round && (m.to === 'peekingLeft' || m.to === 'peekingRight'));
            if (!first) continue;
            if (first.to === 'peekingLeft') left++;
            if (first.to === 'peekingRight') right++;
            if (round.route) {
              withRoute++;
              if ((round.route === 'left' && first.to === 'peekingRight') || (round.route === 'right' && first.to === 'peekingLeft')) wrong++;
            }
          }
          return [r.brain, String(left), String(right), withRoute ? `${wrong}/${withRoute} (${pct(wrong / withRoute)})` : '-'];
        }),
      ),
      '',
    );
  }

  const jev = runs.find((r) => r.brain === 'jev');
  if (jev && jev.rounds.length) {
    const jw = jev.rounds.filter((x) => x.result === 'win').length;
    const jn = jev.rounds.length;
    const others = runs.filter((r) => r !== jev && r.rounds.length);
    if (others.length) {
      out.push('## Jev against each baseline', '');
      out.push('Wins against non-wins (draws count as non-wins). Fisher exact is two-sided.', '');
      out.push(
        table(
          ['vs', 'difference', "Cohen's h", 'Fisher p', 'rounds/brain for 80% power'],
          others.map((o) => {
            const ow = o.rounds.filter((x) => x.result === 'win').length;
            const on = o.rounds.length;
            const p1 = jw / jn;
            const p2 = ow / on;
            return [
              o.brain,
              `${p1 >= p2 ? '+' : ''}${(100 * (p1 - p2)).toFixed(1)} pts`,
              cohenH(p1, p2).toFixed(2),
              fisher(jw, jn - jw, ow, on - ow).toPrecision(2),
              String(roundsNeeded(p1, p2)),
            ];
          }),
        ),
        '',
      );
    }
  }

  out.push('## Opening', '');
  out.push(
    `"At once" is a first peek within ${AT_ONCE_S}s of the round starting. Early and late split each block at round ${EARLY_ROUNDS}: ` +
      'a brain that adapts to the opponent should open differently late than early.',
    '',
  );
  out.push(
    table(
      ['brain', 'peeked at once', `rounds 1-${EARLY_ROUNDS}`, `rounds ${EARLY_ROUNDS + 1}+`, 'won after peeking at once', 'won after waiting'],
      runs.map((r) => {
        const atOnce = (x: BrainRun['rounds'][number]) => x.firstPeekS !== null && x.firstPeekS <= AT_ONCE_S;
        const share = (rs: BrainRun['rounds']) => (rs.length ? `${pct(rs.filter(atOnce).length / rs.length)} of ${rs.length}` : '-');
        const won = (rs: BrainRun['rounds']) => (rs.length ? `${pct(rs.filter((x) => x.result === 'win').length / rs.length)} of ${rs.length}` : '-');
        return [
          r.brain,
          share(r.rounds),
          share(r.rounds.filter((x) => x.index <= EARLY_ROUNDS)),
          share(r.rounds.filter((x) => x.index > EARLY_ROUNDS)),
          won(r.rounds.filter(atOnce)),
          won(r.rounds.filter((x) => !atOnce(x))),
        ];
      }),
    ),
    '',
  );

  out.push('## From decision to move', '');
  out.push(
    `A decision is "acted" when it chose a move rather than waiting, and "delivered" when the machine took it. ` +
      `"Next move" is the first state change within ${NEXT_MOVE_MS / 1000}s of the answer.`,
    '',
  );
  out.push(
    table(
      ['brain', 'decisions', 'from cache', 'acted', 'delivered', 'shots/round', 'state changes/round'],
      runs.map((r) => {
        const acted = r.decisions.filter((d) => d.choice !== NOOP_ID);
        const n = r.rounds.length || 1;
        return [
          r.brain,
          String(r.decisions.length),
          pct(r.decisions.filter((d) => d.cached).length / (r.decisions.length || 1)),
          pct(acted.length / (r.decisions.length || 1)),
          pct(acted.filter((d) => d.sent).length / (acted.length || 1)),
          (r.moves.filter((m) => m.fired).length / n).toFixed(1),
          (r.moves.filter((m) => m.from !== m.to).length / n).toFixed(1),
        ];
      }),
    ),
    '',
  );
  const nextMove = (r: BrainRun, d: Decision) => {
    const after = d.at + d.ms;
    const m = r.moves.find((x) => x.round === d.round && x.at >= after - 50 && x.at <= after + NEXT_MOVE_MS);
    return m ? (m.fired ? 'fired' : `${m.from}→${m.to}`) : 'no change';
  };
  const rowsNext: string[][] = [];
  for (const r of runs) {
    const byChoice = new Map<string, Map<string, number>>();
    for (const d of r.decisions.filter((x) => x.choice !== NOOP_ID && x.sent)) {
      const m = byChoice.get(d.choice) ?? new Map<string, number>();
      const next = nextMove(r, d);
      m.set(next, (m.get(next) ?? 0) + 1);
      byChoice.set(d.choice, m);
    }
    for (const [choice, m] of byChoice) {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      rowsNext.push([
        r.brain,
        short(choice),
        String(total),
        [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v / total)}`).join(', '),
      ]);
    }
  }
  if (rowsNext.length) out.push(table(['brain', 'chose', 'n', 'next move'], rowsNext), '');

  out.push('## What each brain chose, by situation', '');
  out.push('Share of decisions in that situation. `n` is decisions; rounds are counted by how they ended.', '');
  const buckets = new Map<string, number>();
  for (const r of runs) for (const d of r.decisions) buckets.set(bucket(d.situation), (buckets.get(bucket(d.situation)) ?? 0) + 1);
  for (const [b] of [...buckets].sort((x, y) => y[1] - x[1])) {
    const rows = runs
      .map((r) => {
        const ds = r.decisions.filter((d) => bucket(d.situation) === b && d.choice);
        if (!ds.length) return null;
        const counts = new Map<string, { n: number; wins: number }>();
        for (const d of ds) {
          const c = counts.get(d.choice!) ?? { n: 0, wins: 0 };
          c.n++;
          if (d.result === 'win') c.wins++;
          counts.set(d.choice!, c);
        }
        const parts = [...counts]
          .sort((x, y) => y[1].n - x[1].n)
          .map(([choice, c]) => `${short(choice)} ${pct(c.n / ds.length)} (won ${pct(c.wins / c.n)})`);
        return [r.brain, String(ds.length), parts.join(', ')];
      })
      .filter((x): x is string[] => x !== null);
    out.push(`**${b}**`, '', table(['brain', 'n', 'choices (rounds won after that choice)'], rows), '');
  }

  if (jev && jev.decisions.length) {
    const agree = jev.decisions.filter((d) => d.choice === ruleChoice(d.situation, d.options));
    const differ = jev.decisions.filter((d) => d.choice !== ruleChoice(d.situation, d.options));
    const winRate = (ds: Decision[]) => {
      const rounds = new Map(ds.map((d) => [d.round, d.result]));
      const w = [...rounds.values()].filter((x) => x === 'win').length;
      return rounds.size ? `${pct(w / rounds.size)} of ${rounds.size} rounds` : '-';
    };
    out.push('## Where Jev departs from the rules', '');
    out.push(
      `Jev agreed with the hand-written rules on ${pct(agree.length / jev.decisions.length)} of ${jev.decisions.length} decisions. ` +
        `Rounds containing a departure were won ${winRate(differ)}; rounds with none, ${winRate(jev.decisions.filter((d) => !differ.some((x) => x.round === d.round)))}.`,
      '',
    );
    const pairs = new Map<string, Decision[]>();
    for (const d of differ) {
      const key = `${bucket(d.situation)} — rules: ${short(ruleChoice(d.situation, d.options))}, Jev: ${short(d.choice!)}`;
      pairs.set(key, [...(pairs.get(key) ?? []), d]);
    }
    out.push(
      table(
        ['situation — what each chose', 'times', 'rounds won', 'Jev confidence'],
        [...pairs]
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 12)
          .map(([k, ds]) => [k, String(ds.length), winRate(ds), pct(ds.reduce((a, d) => a + (d.confidence ?? 0), 0) / ds.length)]),
      ),
      '',
    );
    const lat = jev.decisions.filter((d) => !d.cached).map((d) => d.ms).sort((a, b) => a - b);
    if (lat.length) {
      out.push(`Jev latency: median ${lat[Math.floor(lat.length / 2)]}ms, p90 ${lat[Math.floor(lat.length * 0.9)]}ms over ${lat.length} requests (cached answers excluded).`, '');
    }
  }

  out.push(
    '_Associations, not causes: a choice that precedes more wins may simply be made in situations that were already winning. The causal claim rests on the outcome table, where only the brain differs._',
  );
  return out.join('\n');
}

/** `--look=a,b,cap`: only the stopping-rule verdict for brain a against b, capped at `cap` rounds each. */
function look(runs: BrainRun[], spec: string): string {
  const [a, b, cap] = spec.split(',');
  const [A, B] = [a, b].map((name) => runs.find((r) => r.brain === name));
  if (!A || !B) throw new Error(`--look: need runs for ${a} and ${b}`);
  const wins = (r: BrainRun) => r.rounds.filter((x) => x.result === 'win').length;
  const n = Math.min(A.rounds.length, B.rounds.length);
  const z = twoPropZ(wins(A), A.rounds.length, wins(B), B.rounds.length);
  const t = n / Number(cap);
  return `look: ${a} ${wins(A)}/${A.rounds.length}, ${b} ${wins(B)}/${B.rounds.length}, z ${z.toFixed(2)}, ` +
    `t ${t.toFixed(2)}, conditional power ${pct(conditionalPower(z, t))} -> ${sequentialLook(z, t)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const lookSpec = args.find((a) => a.startsWith('--look='))?.slice('--look='.length);
  const dirs = args.filter((a) => !a.startsWith('--'));
  if (!dirs.length) throw new Error('usage: analyze.ts <run dir>... [--look=a,b,cap]');
  const order = ['jev', 'jevmem', 'rule', 'rush', 'rushhold', 'random', 'mock'];
  const files = dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => join(dir, f)),
  );
  const runs = mergeRuns(files.map((f, i) => readRun(f, i * 100_000))).sort((a, b) => order.indexOf(a.brain) - order.indexOf(b.brain));
  console.log(lookSpec ? look(runs, lookSpec) : report(runs));
}
