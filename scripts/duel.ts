/**
 * Headless A-long duel: the real enemy machine, the real map and the real
 * combat numbers, against a scripted player. No renderer, so it runs against
 * live Jev in a terminal and says whether the bot actually plays the angle.
 *
 *   pnpm duel            # mock Jev unless TYPESAFE_API_KEY is set
 *   pnpm duel rusher     # scripted player: rusher | holder | jiggler
 */
import { createActor } from 'xstate';
import { mockAnswers, type JevClient } from '@xstate/jev';
import { AWP_DMG, RIFLE_BODY, ROUND_SECONDS, awpHitChance } from '../src/game/combat';
import { PEEK_MS, createEnemyMachine } from '../src/game/enemyMachine';
import { ENEMY_HOLD, ENEMY_PEEK, JIGGLE, LANE_M, PLAYER_SPAWN, ROUTES, type Behaviour, blocked, collide } from '../src/game/map';

const TICK_MS = 1000 / 60;
/** The round the game plays, not a second one: a sim on a different clock measures nothing. */
const MAX_SECONDS = ROUND_SECONDS;
const PLAYER_SPEED = 5.5;
/** Running this close is audible through a wall. Matches the renderer. */
const FOOTSTEP_RANGE = 12;

const behaviour = (process.argv[2] as Behaviour) ?? 'rusher';

async function makeClient(): Promise<JevClient> {
  if (!process.env.TYPESAFE_API_KEY) {
    console.log('(no TYPESAFE_API_KEY: mock Jev)');
    return async (req) => mockAnswers(req);
  }
  const { TypeSafeClient } = await import('@typesafe-ai/sdk');
  const ts = new TypeSafeClient({ timeout: 30_000 });
  return async (req) => ({ answers: (await ts.systemOne({ state: req.state as never, questions: req.questions as never })).answers as never });
}

const actor = createActor(createEnemyMachine(await makeClient()));

const world = {
  px: PLAYER_SPAWN.x,
  pz: PLAYER_SPAWN.z,
  speed: 0,
  playerHp: 100,
  enemyHp: 100,
  et: 0,
  etTarget: 0,
  lastSeenAt: null as number | null,
  visibleSince: null as number | null,
  t: 0,
};

const enemyX = () => ENEMY_HOLD.x + (ENEMY_PEEK.x - ENEMY_HOLD.x) * world.et;
const visible = () => !blocked(enemyX(), ENEMY_HOLD.z, world.px, world.pz);
const enemyMoving = () => Math.abs(world.et - world.etTarget) > 0.01;
const distance = () => Math.hypot(world.px - enemyX(), world.pz - ENEMY_HOLD.z);
const log = (...parts: unknown[]) => console.log(`${world.t.toFixed(1).padStart(5)}s`, ...parts);

let state = 'holding';
let shots = 0;
actor.subscribe((s) => {
  const value = String(s.value);
  if (value !== state) {
    if (value === 'holding') world.etTarget = 0;
    else if (value === 'peeking') world.etTarget = 1;
    else if (state === 'peeking') world.etTarget = world.et;
    log(`bot ${state} -> ${value}`);
    state = value;
  }
  if (s.context.shots > shots) {
    shots = s.context.shots;
    const chance = awpHitChance({
      enemyMoving: enemyMoving(),
      playerSpeed: world.speed,
      onTarget: world.visibleSince === null ? 0 : world.t - world.visibleSince,
    });
    const hit = visible() && Math.random() < chance;
    log(`bot fires (p=${chance.toFixed(2)})`, hit ? 'HIT' : 'miss');
    if (hit) {
      world.playerHp = Math.max(0, world.playerHp - AWP_DMG);
      if (world.playerHp <= 0) actor.send({ type: 'world.playerDead' });
    }
  }
});
actor.start();

// Kept as they arrive: the agent is a child of the machine, and goes away with it when the round ends.
const decisions: any[] = [];
const jev = actor.getSnapshot().children.jev as any;
jev?.subscribe((s: any) => {
  for (const d of [...s.context.decisions].reverse()) {
    if (decisions.some((seen) => seen.at === d.at)) continue;
    decisions.push(d);
    log(`jev ${d.reason}: ${d.event?.type ?? '—'} ${Math.round(d.confidence * 100)}% ${d.cached ? '(cached)' : `${d.latencyMs}ms`}`);
  }
  if (s.context.error) log(`jev error: ${s.context.error}`);
});

/**
 * Waypoints the scripted player walks live in `map.ts`, beside the geometry
 * they have to agree with. From spawn in cover behind the right crate, the
 * rusher steps out into the lane, runs it, and swings wide right at the end:
 * clearing the pillar is the only way to see a bot that is holding, so a
 * player who stops short can never win the round.
 */
const route = ROUTES[behaviour] ?? ROUTES.rusher;
let leg = 0;

function script(t: number): { x: number; z: number } {
  const here = route[Math.min(leg, route.length - 1)];
  if (leg < route.length - 1 && Math.hypot(here.x - world.px, here.z - world.pz) < 0.6) leg++;
  // Once at the end of the route the jiggler keeps stepping in and out of the angle.
  if (behaviour === 'jiggler' && leg === route.length - 1) return { x: JIGGLE.x, z: Math.sin(t * 1.2) * JIGGLE.amplitude + JIGGLE.z };
  return route[Math.min(leg, route.length - 1)];
}

let lastShot = 0;
let seenSince: number | null = null;
let lastSync = 0;
let lastCtx = '';

const timer = setInterval(() => {
  const dt = TICK_MS / 1000;
  world.t += dt;

  const want = script(world.t);
  const dx = want.x - world.px, dz = want.z - world.pz;
  const d = Math.hypot(dx, dz);
  world.speed = d > 0.2 ? PLAYER_SPEED : 0;
  if (d > 0) {
    const move = Math.min(d, world.speed * dt);
    const next = collide(world.px + (dx / d) * move, world.pz + (dz / d) * move, 0.4);
    world.px = next.x; world.pz = next.z;
  }

  const step = dt / (PEEK_MS / 1000);
  world.et = world.et < world.etTarget ? Math.min(world.etTarget, world.et + step) : Math.max(world.etTarget, world.et - step);

  // Player shoots whenever it can see the bot, after a human reaction delay.
  // Hit chance stands in for aim: worse at range, much worse while running.
  if (!visible()) { seenSince = null; world.visibleSince = null; }
  else {
    seenSince ??= world.t;
    world.visibleSince ??= world.t;
    const ready = world.t - seenSince > 0.25 && world.t - lastShot > 0.15;
    if (ready && world.enemyHp > 0) {
      lastShot = world.t;
      const aim = Math.max(0.08, 0.9 - distance() / (LANE_M * 1.2)) * (world.speed > 1 ? 0.3 : 1);
      if (Math.random() < aim) {
        world.enemyHp = Math.max(0, world.enemyHp - RIFLE_BODY);
        log(`player hits, bot hp ${world.enemyHp}`);
        if (world.enemyHp <= 0) actor.send({ type: 'world.enemyDead' });
        else actor.send({ type: 'world.sync', hp: world.enemyHp });
      }
    }
  }

  if (world.t - lastSync > 0.2) {
    lastSync = world.t;
    const vis = visible();
    if (vis) world.lastSeenAt = world.t;
    const patch = {
      playerVisible: vis,
      playerMoving: world.speed > 1,
      playerDistance: Math.round(distance()),
      playerHp: world.playerHp,
      heardFootsteps: world.speed > 2.5 && distance() < FOOTSTEP_RANGE,
      sinceSeen: world.lastSeenAt === null ? -1 : world.t - world.lastSeenAt,
      roundLeft: Math.max(0, MAX_SECONDS - world.t),
    };
    const key = JSON.stringify({ ...patch, playerDistance: Math.round(patch.playerDistance / 2), sinceSeen: Math.round(patch.sinceSeen / 2), roundLeft: Math.round(patch.roundLeft / 5) });
    if (key !== lastCtx) { lastCtx = key; actor.send({ type: 'world.sync', ...patch }); }
  }

  if (world.t > MAX_SECONDS) actor.send({ type: 'world.roundOver' });
  if (actor.getSnapshot().status !== 'active') finish();
}, TICK_MS);

function finish() {
  clearInterval(timer);
  const chosen = decisions.filter((d) => d.event).length;
  const latency = decisions.filter((d) => !d.cached).map((d) => d.latencyMs as number);
  console.log('---');
  console.log(`player: ${behaviour} · bot hp ${world.enemyHp} · player hp ${world.playerHp}`);
  console.log(`outcome: ${String(actor.getSnapshot().value)}`);
  console.log(`jev: ${decisions.length} decisions, ${chosen} acted on, ${decisions.length - chosen} waits`);
  if (latency.length) console.log(`latency: median ${latency.sort((a: number, b: number) => a - b)[Math.floor(latency.length / 2)]}ms over ${latency.length} live requests`);
  actor.stop();
  process.exit(0);
}
