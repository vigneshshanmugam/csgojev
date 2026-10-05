/**
 * Fast pre-engine check for the split-lane idea.
 *
 * It is not the CS result. It only answers whether the proposed geometry and
 * cue timing make a lever plausible before we spend time on BSP/nav/plugin work.
 */
import { AWP_DMG, RIFLE_BODY, awpHitChance } from '../src/game/combat';
import { blocked } from '../src/game/map';
import { SPLIT_BOXES, SPLIT_HOLD, SPLIT_PEEK_L, SPLIT_PEEK_R, SPLIT_ROUTES, type SplitRoute } from '../src/game/split';

type Brain = 'left' | 'right' | 'cue';
type Result = 'win' | 'loss' | 'draw';

const TICK = 1 / 60;
const ROUND_SECONDS = 45;
const PLAYER_SPEED = 5.5;
const FOOTSTEP_RANGE = 12;
const PEEK_SECONDS = 0.55;
const AIM_SECONDS = 0.35;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function peekFor(side: SplitRoute) {
  return side === 'left' ? SPLIT_PEEK_L : SPLIT_PEEK_R;
}

function run(brain: Brain, route: SplitRoute, rand: () => number): Result {
  const points = SPLIT_ROUTES[route];
  let target = 0;
  let px = points[0].x, pz = points[0].z;
  let hp = 100, enemyHp = 100;
  let peekAt: number | null = brain === 'left' || brain === 'right' ? 0 : null;
  let peekSide: SplitRoute | null = brain === 'left' ? 'left' : brain === 'right' ? 'right' : null;
  let seenSince: number | null = null;
  let lastPlayerShot = -100;
  let fired = false;

  for (let t = 0; t < ROUND_SECONDS; t += TICK) {
    const here = points[Math.min(target, points.length - 1)];
    if (target < points.length - 1 && Math.hypot(here.x - px, here.z - pz) < 0.6) target++;
    const want = points[Math.min(target, points.length - 1)];
    const d = Math.hypot(want.x - px, want.z - pz);
    if (d > 0) {
      const move = Math.min(d, PLAYER_SPEED * TICK);
      px += (want.x - px) / d * move;
      pz += (want.z - pz) / d * move;
    }

    const heard = Math.hypot(px - SPLIT_HOLD.x, pz - SPLIT_HOLD.z) < FOOTSTEP_RANGE;
    if (brain === 'cue' && peekAt === null && heard) {
      peekAt = t;
      peekSide = route;
    }

    const peek = peekSide ? peekFor(peekSide) : SPLIT_HOLD;
    const exposed = peekAt !== null && t >= peekAt + PEEK_SECONDS;
    const visible = exposed && !blocked(peek.x, peek.z, px, pz, SPLIT_BOXES);

    if (visible) {
      seenSince ??= t;
      if (t - lastPlayerShot > 0.15 && t - seenSince > 0.25) {
        lastPlayerShot = t;
        const dist = Math.hypot(px - peek.x, pz - peek.z);
        const chance = Math.max(0.08, 0.9 - dist / 30) * 0.3; // moving rifler
        if (rand() < chance) hp = Math.max(0, hp - RIFLE_BODY);
      }
    } else {
      seenSince = null;
    }

    if (!fired && visible && t >= (peekAt ?? 0) + PEEK_SECONDS + AIM_SECONDS) {
      fired = true;
      const chance = awpHitChance({ enemyMoving: false, playerSpeed: PLAYER_SPEED, onTarget: AIM_SECONDS });
      if (rand() < chance) enemyHp = Math.max(0, enemyHp - AWP_DMG);
    }

    if (enemyHp <= 0) return 'win';
    if (hp <= 0) return 'loss';
  }
  return 'draw';
}

const rounds = Number(process.argv[2] ?? 10_000);
const seed = Number(process.argv[3] ?? 1);
const rand = rng(seed);

for (const brain of ['left', 'right', 'cue'] as const) {
  const counts = { win: 0, loss: 0, draw: 0 };
  const byRoute: Record<SplitRoute, typeof counts> = {
    left: { win: 0, loss: 0, draw: 0 },
    right: { win: 0, loss: 0, draw: 0 },
  };
  for (let i = 0; i < rounds; i++) {
    const route: SplitRoute = rand() < 0.5 ? 'left' : 'right';
    const result = run(brain, route, rand);
    counts[result]++;
    byRoute[route][result]++;
  }
  console.log(`${brain}: ${counts.win}-${counts.loss}-${counts.draw} (${(100 * counts.win / rounds).toFixed(1)}%)`);
  console.log(`  left route: ${byRoute.left.win}-${byRoute.left.loss}-${byRoute.left.draw}`);
  console.log(`  right route: ${byRoute.right.win}-${byRoute.right.loss}-${byRoute.right.draw}`);
}
