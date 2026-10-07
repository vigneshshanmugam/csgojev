/**
 * Baseline brains for the Jev comparison. Each is a `JevClient`: it receives
 * the request Jev would receive (what the bot sees, and the legal moves the
 * machine offers right now) and answers in Jev's shape. The body, the machine
 * and the opponent stay identical; only the decision-maker changes.
 *
 *   random  picks uniformly among the offered moves (including waiting)
 *   rule    a hand-written AWPer: fixed if/then rules over the same cues
 *   rush    the aggressive AWPer: peek at once, scope up at the peek spot,
 *           otherwise the rule brain. Tests whether Jev beats "be aggressive".
 *   rushhold  rush that never falls back while scoped (see rushHoldChoice)
 *   left/right fixed split-lane openers
 *   cue     split-lane script: wait for side cues, then peek that side
 *   sweep   split-lane script: check left, then switch sides after a dry peek
 */
import { NOOP_ID, type JevAnswer, type JevClient, type JevRequest } from '@xstate/jev';

export const brains = ['jev', 'jevmem', 'rule', 'rush', 'rushhold', 'left', 'right', 'cue', 'cuehold', 'cuewait', 'cueswitch', 'cueswitch5', 'cueswitch7', 'cuecheck', 'sweep', 'random', 'mock'] as const;
/** Brains that call Jev, and so need a key to mean anything. */
export const isJev = (brain: string) => brain === 'jev' || brain === 'jevmem';
export type BrainName = (typeof brains)[number];

/** What `createEnemyMachine` shows the brain. Mirrors its `state` callback. */
export interface Situation {
  you: 'holding' | 'peeking' | 'scoped' | 'cycling' | string;
  playerInSight: boolean;
  aim?: 'not on them' | 'still settling, no shot yet' | 'half settled, a rushed shot' | 'settled, your best shot';
  playerMoving: boolean;
  playerDistanceM: number;
  footstepsHeard: boolean;
  secondsSincePlayerSeen: number | 'never seen this round';
  yourHp: number;
  playerHp: number;
  roundSecondsLeft: number;
  side?: 'left' | 'right' | 'behind cover';
  footstepsFrom?: 'left' | 'right' | 'none';
  playerLastSeenOn?: 'left' | 'right' | 'unknown' | 'never seen this round';
}

const PEEK = 'enemy.peek';
const PEEK_LEFT = 'enemy.peekLeft';
const PEEK_RIGHT = 'enemy.peekRight';
const STRAFE = 'enemy.counterStrafe';
const SHOOT = 'enemy.shoot';
const FALL_BACK = 'enemy.fallBack';
type SplitSide = 'left' | 'right';

/** The thresholds the rule brain acts on, in one place so a report can quote them. */
export const RULES = {
  /** Peek from cover once the attacker is this close (metres). */
  peekWithinM: 14,
  /** Or once it has been quiet this long (seconds since last seen). */
  peekAfterQuietS: 6,
  /** Or when the round is this close to running out (seconds). */
  peekWhenRoundLeftS: 20,
  /** Take a half-settled shot only when the attacker is this close (metres). */
  rushedShotWithinM: 8,
  /** Below this HP, retreat rather than wait for aim to settle. */
  retreatBelowHp: 50,
} as const;
/** How long sweep commits to a dry side before checking the other lane. */
export const SWEEP_SIDE_SECONDS = 3;

/** The rule brain's choice for one situation, from the options the machine offers. */
export function ruleChoice(s: Situation, offered: readonly string[]): string {
  const has = (id: string) => offered.includes(id);
  const wait = has(NOOP_ID) ? NOOP_ID : offered[0];
  const quiet = typeof s.secondsSincePlayerSeen === 'number' ? s.secondsSincePlayerSeen : 0;

  if (has(SHOOT)) {
    if (s.aim === 'settled, your best shot') return SHOOT;
    if (s.aim === 'half settled, a rushed shot' && s.playerDistanceM <= RULES.rushedShotWithinM) return SHOOT;
  }
  if (s.you === 'cycling') return has(FALL_BACK) ? FALL_BACK : wait;
  if (s.you.startsWith('peeking')) return s.playerInSight && has(STRAFE) ? STRAFE : wait;
  if (s.you === 'scoped') {
    if (s.playerInSight && s.yourHp < RULES.retreatBelowHp && has(FALL_BACK)) return FALL_BACK;
    return wait;
  }
  if (s.you === 'holding' && has(PEEK)) {
    if (s.footstepsHeard) return PEEK;
    if (s.playerDistanceM <= RULES.peekWithinM) return PEEK;
    if (quiet >= RULES.peekAfterQuietS) return PEEK;
    if (s.roundSecondsLeft <= RULES.peekWhenRoundLeftS) return PEEK;
  }
  return wait;
}

/** The rush brain: no waiting in cover, and the scope goes up before the attacker shows. */
export function rushChoice(s: Situation, offered: readonly string[]): string {
  if (s.you === 'holding' && offered.includes(PEEK)) return PEEK;
  if (s.you === 'peeking' && offered.includes(STRAFE)) return STRAFE;
  return ruleChoice(s, offered);
}

/**
 * Rush with one rule removed: it never falls back while scoped, hurt or not,
 * so the scope time already spent is never thrown away. The only difference
 * from `rush`, so a gap between the two is that rule's doing.
 */
export function rushHoldChoice(s: Situation, offered: readonly string[]): string {
  const choice = rushChoice(s, offered);
  return s.you === 'scoped' && choice === FALL_BACK && offered.includes(NOOP_ID) ? NOOP_ID : choice;
}

const peekFor = (side: 'left' | 'right') => side === 'left' ? PEEK_LEFT : PEEK_RIGHT;
const otherSide = (side: SplitSide): SplitSide => side === 'left' ? 'right' : 'left';
const splitSide = (side: Situation['side']): SplitSide | null => side === 'left' || side === 'right' ? side : null;

export function fixedSideChoice(side: 'left' | 'right', s: Situation, offered: readonly string[]): string {
  const pick = peekFor(side);
  if (s.you === 'holding' && offered.includes(pick)) return pick;
  if (s.you.startsWith('peeking') && offered.includes(STRAFE)) return STRAFE;
  return ruleChoice(s, offered);
}

export function cueChoice(s: Situation, offered: readonly string[], rand: () => number = Math.random): string {
  const has = (id: string) => offered.includes(id);
  const cue =
    s.footstepsFrom === 'left' || s.footstepsFrom === 'right' ? s.footstepsFrom
      : s.playerLastSeenOn === 'left' || s.playerLastSeenOn === 'right' ? s.playerLastSeenOn
        : null;
  const quiet = typeof s.secondsSincePlayerSeen === 'number' ? s.secondsSincePlayerSeen : 0;
  const fallback = rand() < 0.5 ? 'left' : 'right';
  const side = cue ?? (quiet >= RULES.peekAfterQuietS || s.roundSecondsLeft <= RULES.peekWhenRoundLeftS ? fallback : null);
  if (s.you === 'holding' && side && has(peekFor(side))) return peekFor(side);
  if (s.you.startsWith('peeking') && has(STRAFE)) return STRAFE;
  return ruleChoice(s, offered);
}

/**
 * Cue with the scoped retreat removed: the only difference from `cue`, so a gap
 * between the two is that rule's doing. Tests whether Jev's edge over `cue`
 * is lane choice (equal here) or simply never falling back.
 */
export function cueHoldChoice(s: Situation, offered: readonly string[], rand: () => number = Math.random): string {
  const choice = cueChoice(s, offered, rand);
  return s.you === 'scoped' && choice === FALL_BACK && offered.includes(NOOP_ID) ? NOOP_ID : choice;
}

/**
 * `cuehold` that finishes the peek while the attacker is out of sight: it
 * waits instead of counter-strafing part way out (as `sweep` does). The only
 * difference from `cuehold`, so a gap between them is that stop's doing.
 */
export function cueWaitChoice(s: Situation, offered: readonly string[], rand: () => number = Math.random): string {
  if (s.you.startsWith('peeking') && !s.playerInSight && offered.includes(NOOP_ID)) return NOOP_ID;
  return cueHoldChoice(s, offered, rand);
}

export function createSweepChoice(now: () => number = () => Date.now() / 1000): (s: Situation, offered: readonly string[]) => string {
  let nextSide: SplitSide = 'left';
  let active: { side: SplitSide; startedAt: number; sawPlayer: boolean } | null = null;
  let lastRoundSecondsLeft: number | undefined;

  return (s, offered) => {
    const has = (id: string) => offered.includes(id);
    const currentSide = splitSide(s.side);
    if (lastRoundSecondsLeft !== undefined && s.roundSecondsLeft > lastRoundSecondsLeft) {
      nextSide = 'left';
      active = null;
    }
    lastRoundSecondsLeft = s.roundSecondsLeft;

    if (s.you === 'holding' && has(peekFor(nextSide))) {
      active = { side: nextSide, startedAt: now(), sawPlayer: false };
      return peekFor(nextSide);
    }

    if (currentSide && (!active || active.side !== currentSide)) {
      active = { side: currentSide, startedAt: now(), sawPlayer: s.playerInSight };
    }
    if (active && s.playerInSight) active.sawPlayer = true;
    if ((s.you.startsWith('peeking') || s.you === 'scoped') && active && !active.sawPlayer && now() - active.startedAt >= SWEEP_SIDE_SECONDS && has(FALL_BACK)) {
      nextSide = otherSide(active.side);
      active = null;
      return FALL_BACK;
    }

    return ruleChoice(s, offered);
  };
}

/**
 * Cue reader that cross-checks itself: it peeks the cued lane like `cuehold`,
 * but a lane that shows nothing for `switchAfterS` (default SWEEP_SIDE_SECONDS, which proved too eager on a mostly-true cue) is dropped (fall back)
 * and the other lane is tried. Built to measure headroom when the cue lies:
 * if this does not beat `cue` on a noisy cue, there is nothing for a smarter
 * brain to recover.
 */
export function createCueSwitchChoice(
  now: () => number = () => Date.now() / 1000,
  rand: () => number = Math.random,
  switchAfterS: number = SWEEP_SIDE_SECONDS,
): (s: Situation, offered: readonly string[]) => string {
  let avoid: SplitSide | null = null;
  let active: { side: SplitSide; startedAt: number; sawPlayer: boolean } | null = null;
  let lastRoundSecondsLeft: number | undefined;

  return (s, offered) => {
    const has = (id: string) => offered.includes(id);
    const currentSide = splitSide(s.side);
    if (lastRoundSecondsLeft !== undefined && s.roundSecondsLeft > lastRoundSecondsLeft) {
      avoid = null;
      active = null;
    }
    lastRoundSecondsLeft = s.roundSecondsLeft;

    if (s.you === 'holding' && avoid && has(peekFor(otherSide(avoid)))) {
      const side = otherSide(avoid);
      active = { side, startedAt: now(), sawPlayer: false };
      return peekFor(side);
    }
    const choice = cueHoldChoice(s, offered, rand);
    if (s.you === 'holding' && (choice === PEEK_LEFT || choice === PEEK_RIGHT)) {
      active = { side: choice === PEEK_LEFT ? 'left' : 'right', startedAt: now(), sawPlayer: false };
      return choice;
    }

    if (currentSide && (!active || active.side !== currentSide)) {
      active = { side: currentSide, startedAt: now(), sawPlayer: s.playerInSight };
    }
    if (active && s.playerInSight) active.sawPlayer = true;
    if ((s.you.startsWith('peeking') || s.you === 'scoped') && active && !active.sawPlayer && now() - active.startedAt >= switchAfterS && has(FALL_BACK)) {
      avoid = active.side;
      active = null;
      return FALL_BACK;
    }
    return choice;
  };
}

/**
 * Cue reader that remembers which lane came up empty. A lane is dry when a
 * peek ends (the machine is back in cover, whether by choice or by its own
 * 5s exposure reflex) without the player ever having been in sight, and the
 * next peek goes to the other lane. A sighting beats the footsteps label: once
 * the player has been seen on a lane, that lane is the lane. No timers, so
 * nothing races the machine's reflex (which beat `cueswitch`'s timer).
 */
export function createCueCheckChoice(rand: () => number = Math.random): (s: Situation, offered: readonly string[]) => string {
  let avoid: SplitSide | null = null;
  let active: { side: SplitSide; sawPlayer: boolean } | null = null;
  let lastRoundSecondsLeft: number | undefined;

  return (s, offered) => {
    const has = (id: string) => offered.includes(id);
    if (lastRoundSecondsLeft !== undefined && s.roundSecondsLeft > lastRoundSecondsLeft) {
      avoid = null;
      active = null;
    }
    lastRoundSecondsLeft = s.roundSecondsLeft;

    if (active && s.playerInSight) active.sawPlayer = true;
    if (s.you === 'holding' && active) {
      if (!active.sawPlayer) avoid = active.side;
      active = null;
    }
    if (s.you === 'holding') {
      const seenOn = s.playerLastSeenOn === 'left' || s.playerLastSeenOn === 'right' ? s.playerLastSeenOn : null;
      const side = seenOn ?? (avoid ? otherSide(avoid) : null);
      if (side && has(peekFor(side))) {
        active = { side, sawPlayer: false };
        return peekFor(side);
      }
      const choice = cueHoldChoice(s, offered, rand);
      if (choice === PEEK_LEFT || choice === PEEK_RIGHT) active = { side: choice === PEEK_LEFT ? 'left' : 'right', sawPlayer: false };
      return choice;
    }
    return cueHoldChoice(s, offered, rand);
  };
}

/** Answers every choice question with `pick`, in exactly the shape Jev returns. */
function answerWith(request: JevRequest, pick: (offered: string[]) => { choice: string; probabilities: Record<string, number> }) {
  const answers: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    if (q.type !== 'choice') continue;
    const offered = Object.keys(q.criteria);
    const { choice, probabilities } = pick(offered);
    answers[id] = { type: 'choice', choice, probabilities, confidence: 1 };
  }
  return { answers, mock: true };
}

export const ruleClient = (choose = ruleChoice): JevClient => async (request) =>
  answerWith(request, (offered) => {
    const choice = choose(request.state as Situation, offered);
    return { choice, probabilities: Object.fromEntries(offered.map((o) => [o, o === choice ? 1 : 0])) };
  });

export const cueSwitchClient = (now?: () => number, switchAfterS?: number): JevClient =>
  ruleClient(createCueSwitchChoice(now, undefined, switchAfterS));

export const cueCheckClient = (): JevClient => ruleClient(createCueCheckChoice());

export const sweepClient = (now?: () => number): JevClient => ruleClient(createSweepChoice(now));

export const randomClient = (rand: () => number = Math.random): JevClient => async (request) =>
  answerWith(request, (offered) => ({
    choice: offered[Math.floor(rand() * offered.length)],
    probabilities: Object.fromEntries(offered.map((o) => [o, Number((1 / offered.length).toFixed(4))])),
  }));
