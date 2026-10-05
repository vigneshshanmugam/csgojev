/**
 * A fake Metamod plugin: speaks the real UDP protocol, so the sidecar cannot
 * tell it from the engine. It owns everything the engine owns — the bot walks
 * between waypoints at a pace that varies per leg, the weapon cycles on its
 * own clock, bullets are resolved here — and the sidecar only ever receives
 * perception. Doubles as the eval harness.
 */
import dgram from 'node:dgram';
import { AWP_DMG, RIFLE_BODY, awpHitChance } from '../../../src/game/combat';
import { ENEMY_HOLD, ENEMY_PEEK, JIGGLE, LANE_M, PLAYER_SPAWN, ROUTES, type Behaviour, blocked, collide } from '../../../src/game/map';
import { SPLIT_BOXES, SPLIT_HOLD, SPLIT_LANE_M, SPLIT_PEEK_L, SPLIT_PEEK_R, SPLIT_ROUTES, SPLIT_SPAWN, type SplitRoute } from '../../../src/game/split';
import { HOST, INTENT_PORT, decode, encode, intentSchema, type Intent, type RoundResult, type RouteSide, type Waypoint } from './protocol';

/** The three scripted attackers. They live in `map.ts` with the geometry they have to agree with. */
export { ROUTES, type Behaviour };

/** Running this close is audible through a wall. Matches the renderer. */
const FOOTSTEP_RANGE = 12;

const TICK_MS = 50; // 20Hz, the rate the plugin sends perception at
const PLAYER_SPEED = 5.5;
/** Metres per second the bot swings at. Jittered per leg: real arrival times vary. */
const BOT_SPEED = 6;
/** What the real AWP enforces, which the machine follows instead of simulating. */
const BOLT_MS = 1500;
const SWING_M = Math.hypot(ENEMY_PEEK.x - ENEMY_HOLD.x, ENEMY_PEEK.z - ENEMY_HOLD.z);

export interface FakePluginOptions {
  /** Where the sidecar listens for perception. */
  sidecarPort: number;
  /** Where the sidecar sends intents; this driver binds it. 0 for ephemeral. */
  listenPort?: number;
  host?: string;
  bot?: number;
  behaviour?: Behaviour;
  layout?: 'duel' | 'split';
  route?: SplitRoute | 'random';
  roundSeconds?: number;
  seed?: number;
  log?: (message: string) => void;
}

export interface RoundReport {
  result: RoundResult;
  behaviour: Behaviour;
  route: RouteSide | null;
  botHp: number;
  playerHp: number;
  seconds: number;
  /** Machine states seen, in order, without consecutive repeats. */
  states: string[];
  intents: number;
  shots: number;
  hits: number;
  /** Hit probability of each shot actually taken, in order: what the bot's aim was worth. */
  chances: number[];
  /** Peek swings the bot finished under its own legs. */
  arrivals: number;
}

/** Seeded so the world replays the same way; only Jev's own answers vary. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Binds the intent socket up front so the sidecar can be pointed at it before
 * any round starts, then runs rounds on it one at a time.
 */
export async function openFakePlugin(options: FakePluginOptions) {
  const { sidecarPort, listenPort = INTENT_PORT, host = HOST, bot: botId = 1, log } = options;

  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(listenPort, host, resolve);
  });

  let onIntent: (intent: Intent) => void = () => {};
  socket.on('message', (datagram) => {
    for (const intent of decode(intentSchema, datagram)) {
      if (intent.bot === botId) onIntent(intent);
    }
  });

  let target = sidecarPort;
  const send = (packet: unknown) => socket.send(encode(packet), target, host);

  function round(overrides: Partial<FakePluginOptions> = {}): Promise<RoundReport> {
    const behaviour = overrides.behaviour ?? options.behaviour ?? 'rusher';
    const layout = overrides.layout ?? options.layout ?? 'duel';
    const split = layout === 'split';
    const roundSeconds = overrides.roundSeconds ?? options.roundSeconds ?? 30;
    const random = rng(overrides.seed ?? options.seed ?? 1);
    const routeMode = overrides.route ?? options.route ?? 'random';
    const route: RouteSide = routeMode === 'random' ? (random() < 0.5 ? 'left' : 'right') : routeMode;
    const hold = split ? SPLIT_HOLD : ENEMY_HOLD;
    const peek = (side: RouteSide | null = null) => split
      ? side === 'right' ? SPLIT_PEEK_R : SPLIT_PEEK_L
      : ENEMY_PEEK;
    const routePoints = split ? SPLIT_ROUTES[route] : ROUTES[behaviour];
    const spawn = split ? SPLIT_SPAWN : PLAYER_SPAWN;
    const laneM = split ? SPLIT_LANE_M : LANE_M;
    const boxes = split ? SPLIT_BOXES : undefined;

    const world = {
      t: 0,
      px: spawn.x,
      pz: spawn.z,
      playerSpeed: 0,
      playerHp: 100,
      botHp: 100,
      /** 0 at the hold waypoint, 1 at the peek waypoint. */
      et: 0,
      etTarget: 0,
      side: (split ? null : 'right') as RouteSide | null,
      legMs: (Math.hypot(peek(route).x - hold.x, peek(route).z - hold.z) / BOT_SPEED) * 1000,
      boltUntil: -1,
      lastSeenAt: null as number | null,
      lastSeenSide: null as RouteSide | null,
      /** Seconds the crosshair has been settled on the player: it only builds while stopped and looking at them. */
      onTarget: 0,
    };
    const report: RoundReport = {
      result: 'draw', behaviour, route: split ? route : null, botHp: 100, playerHp: 100, seconds: 0,
      states: [], intents: 0, shots: 0, hits: 0, chances: [], arrivals: 0,
    };

    const botPos = () => {
      const p = peek(world.side);
      return { x: hold.x + (p.x - hold.x) * world.et, z: hold.z + (p.z - hold.z) * world.et };
    };
    const visible = () => {
      const b = botPos();
      return !blocked(b.x, b.z, world.px, world.pz, boxes);
    };
    const botMoving = () => Math.abs(world.et - world.etTarget) > 0.01;
    const distance = () => {
      const b = botPos();
      return Math.hypot(world.px - b.x, world.pz - b.z);
    };
    const waypoint = (): Waypoint | null => {
      if (world.et <= 0.001) return 'hold';
      if (world.et < 0.999) return null;
      if (!split) return 'peek';
      return world.side === 'right' ? 'peekRight' : 'peekLeft';
    };
    const say = (...parts: unknown[]) => log?.(`${world.t.toFixed(1).padStart(5)}s ${parts.join(' ')}`);

    let lastSeq = -1;
    let lastState = '';
    let settled = true;
    let leg = 0;
    let lastShot = 0;
    let seenSince: number | null = null;

    /** The intent says where the bot wants to be; its legs take as long as they take. */
    const applyState = (state: Intent['state']) => {
      if (state === 'peekingLeft') world.side = 'left';
      if (state === 'peekingRight') world.side = 'right';
      const target = ['peeking', 'peekingLeft', 'peekingRight'].includes(state) ? 1 : state === 'holding' ? 0 : world.etTarget;
      if (target === world.etTarget) return;
      world.etTarget = target;
      const p = peek(world.side);
      world.legMs = (Math.hypot(p.x - hold.x, p.z - hold.z) / BOT_SPEED) * 1000 * (0.75 + random() * 0.7);
      settled = false;
    };

    const resolveShot = () => {
      if (world.t < world.boltUntil) return; // the real weapon would have refused it
      report.shots++;
      world.boltUntil = world.t + BOLT_MS / 1000;
      const chance = awpHitChance({
        enemyMoving: botMoving(),
        playerSpeed: world.playerSpeed,
        onTarget: world.onTarget,
      });
      report.chances.push(Number(chance.toFixed(2)));
      const hit = visible() && random() < chance;
      say(`bot fires (p=${chance.toFixed(2)})`, hit ? 'HIT' : 'miss');
      if (!hit) return;
      report.hits++;
      world.playerHp = Math.max(0, world.playerHp - AWP_DMG);
    };

    const playerTarget = (): { x: number; z: number } => {
      const here = routePoints[Math.min(leg, routePoints.length - 1)];
      if (leg < routePoints.length - 1 && Math.hypot(here.x - world.px, here.z - world.pz) < 0.6) leg++;
      // Once at the end of the route the jiggler keeps stepping in and out of the angle.
      if (!split && behaviour === 'jiggler' && leg === routePoints.length - 1) return { x: JIGGLE.x, z: Math.sin(world.t * 1.2) * JIGGLE.amplitude + JIGGLE.z };
      return routePoints[Math.min(leg, routePoints.length - 1)];
    };

    onIntent = (intent) => {
      if (intent.seq <= lastSeq) return; // stale packet
      lastSeq = intent.seq;
      report.intents++;
      if (intent.state !== lastState) {
        lastState = intent.state;
        report.states.push(intent.state);
        say(`intent ${intent.state}`);
      }
      applyState(intent.state);
      if (intent.fire) resolveShot();
    };

    return new Promise<RoundReport>((resolve) => {
      const started = Date.now();
      let last = started;
      send({ t: 'round_start', bot: botId, route: split ? route : undefined });

      const finish = async (result: RoundResult) => {
        clearInterval(timer);
        Object.assign(report, {
          result,
          botHp: world.botHp,
          playerHp: world.playerHp,
          seconds: Number(world.t.toFixed(2)),
        });
        send({ t: 'round_end', bot: botId, result });
        await new Promise((r) => setTimeout(r, 150)); // let the last intents land
        onIntent = () => {};
        resolve(report);
      };

      const timer = setInterval(() => {
        const now = Date.now();
        const dt = (now - last) / 1000;
        last = now;
        world.t = (now - started) / 1000;

        const want = playerTarget();
        const dx = want.x - world.px;
        const dz = want.z - world.pz;
        const d = Math.hypot(dx, dz);
        world.playerSpeed = d > 0.2 ? PLAYER_SPEED : 0;
        if (d > 0) {
          const move = Math.min(d, world.playerSpeed * dt);
          const next = collide(world.px + (dx / d) * move, world.pz + (dz / d) * move, 0.4, boxes);
          world.px = next.x;
          world.pz = next.z;
        }

        // The bot's legs, not a timer: this is what `atWaypoint` reports on.
        const step = (dt * 1000) / world.legMs;
        world.et = world.et < world.etTarget
          ? Math.min(world.etTarget, world.et + step)
          : Math.max(world.etTarget, world.et - step);
        if (!settled && world.et === world.etTarget) {
          settled = true;
          if (world.etTarget === 1) report.arrivals++;
        }

        // Aim settles only while the bot is stopped and looking at them, and
        // is lost the instant either stops being true. This is the engine's
        // job in CS: turn rate and acquire time, measured by the plugin.
        world.onTarget = visible() && !botMoving() ? world.onTarget + dt : 0;

        // Player shoots whatever it can see, after a human reaction delay.
        if (!visible()) {
          seenSince = null;
        } else {
          seenSince ??= world.t;
          world.lastSeenAt = world.t;
          world.lastSeenSide = split ? route : null;
          if (world.t - seenSince > 0.25 && world.t - lastShot > 0.15 && world.botHp > 0 && world.playerHp > 0) {
            lastShot = world.t;
            const aim = Math.max(0.08, 0.9 - distance() / (laneM * 1.2)) * (world.playerSpeed > 1 ? 0.3 : 1);
            if (random() < aim) {
              world.botHp = Math.max(0, world.botHp - RIFLE_BODY);
              say(`player hits, bot hp ${world.botHp}`);
            }
          }
        }

        send({
          t: 'obs',
          bot: botId,
          hp: world.botHp,
          visible: visible(),
          moving: world.playerSpeed > 1,
          dist: Number(distance().toFixed(1)),
          enemyHp: world.playerHp,
          footsteps: world.playerSpeed > 2.5 && distance() < FOOTSTEP_RANGE,
          footstepsFrom: split && world.playerSpeed > 2.5 && distance() < FOOTSTEP_RANGE ? route : null,
          sinceSeen: world.lastSeenAt === null ? -1 : Number((world.t - world.lastSeenAt).toFixed(2)),
          lastSeenSide: world.lastSeenSide,
          roundLeft: Number(Math.max(0, roundSeconds - world.t).toFixed(1)),
          weaponReady: world.t >= world.boltUntil,
          atWaypoint: waypoint(),
          onTarget: Number(world.onTarget.toFixed(2)),
        });

        if (world.playerHp <= 0) {
          send({ t: 'enemy_died', bot: botId });
          void finish('win');
        } else if (world.botHp <= 0) {
          send({ t: 'bot_died', bot: botId });
          void finish('loss');
        } else if (world.t >= roundSeconds) {
          void finish('draw');
        }
      }, TICK_MS);
    });
  }

  return {
    /** The bound intent port, to point the sidecar at when it was ephemeral. */
    port: socket.address().port,
    /** Both ends can be ephemeral: bind this one first, then tell it where the sidecar landed. */
    setSidecarPort: (port: number) => { target = port; },
    round,
    close: () => new Promise<void>((resolve) => socket.close(resolve)),
  };
}

export type FakePlugin = Awaited<ReturnType<typeof openFakePlugin>>;
