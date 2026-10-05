/**
 * One brain per bot: an `enemyMachine` actor fed by `obs` packets, emitting
 * `intent` packets. Everything the engine owns (arrival, bolt, death, round
 * end) arrives as an event; the machine only decides what is legal.
 */
import { createActor, type Actor } from 'xstate';
import type { JevClient, JevDecision } from '@xstate/jev';
import { ACQUIRE_SECONDS, MIN_AIM_SECONDS, aimBucket } from '../../../src/game/combat';
import { createEnemyMachine, type EnemyContext } from '../../../src/game/enemyMachine';
import type { Inbound, Intent, MachineState, Obs } from './protocol';

/**
 * Safety nets, not simulation. The engine reports `atWaypoint` and
 * `weaponReady`; these only fire if the plugin goes quiet or the bot is stuck,
 * so they sit well past any plausible real duration.
 */
export const PEEK_SAFETY_MS = 2000;
export const BOLT_SAFETY_MS = 2500;

/**
 * The acquire model, from the prototype's combat numbers. These are what the
 * real plugin's turn rate and acquire time have to be tuned against, so they
 * stay defined in one place rather than being guessed at on both sides.
 */
export const AIM_MIN_SECONDS = MIN_AIM_SECONDS;
export const AIM_SETTLED_SECONDS = ACQUIRE_SECONDS;

export { aimBucket };

export interface BotStats {
  decisions: number;
  /** Decisions that produced an event, as opposed to a deliberate wait. */
  acted: number;
  /** Latencies of live (uncached) requests, ms. */
  latencies: number[];
}

export interface BotOptions {
  id: number;
  client: JevClient;
  /** Where intents go. The sidecar wires this to the UDP socket. */
  emit: (intent: Intent) => void;
  /** The aim gate, in seconds on target. 0 turns it off, which is what the eval compares against. */
  aimSeconds?: number;
  log?: (message: string) => void;
  /** Every decision the runtime made, cached repeats included. */
  onDecision?: (decision: JevDecision) => void;
  /** Every state change and shot, i.e. what the bot actually did next. */
  onMove?: (move: Move) => void;
  /** Show the brain how its last rounds went (see `roundSummary`). */
  memory?: boolean;
}

/** Rounds of history shown to the brain. */
export const MEMORY_ROUNDS = 5;
/** A first peek this soon after the round starts counts as peeking at once. */
const AT_ONCE_S = 1.5;

/** One line of history: how the round opened and how it ended. */
export function roundSummary(
  firstPeekS: number | null,
  result: 'win' | 'loss' | 'draw',
  diedWhile: MachineState | null,
): string {
  const opened =
    firstPeekS === null ? 'never peeked' : firstPeekS <= AT_ONCE_S ? 'peeked at once' : `waited ${Math.round(firstPeekS)}s, then peeked`;
  const ended =
    result === 'win' ? 'won' : result === 'draw' ? 'draw, the timer ran out' : `lost, killed while ${diedWhile ?? 'unknown'}`;
  return `${opened}; ${ended}`;
}

export interface Move {
  from: MachineState;
  to: MachineState;
  fired: boolean;
}

/** Coarse enough that small jitter in the feed does not re-ask Jev the same question. */
function syncKey(patch: Partial<EnemyContext>): string {
  return JSON.stringify({
    ...patch,
    // Tracks `metres()` in enemyMachine.ts: dedupe coarser than the machine
    // reads and a distance change Jev would act on never reaches it.
    playerDistance: Math.round((patch.playerDistance ?? 0) / 2),
    sinceSeen: Math.round((patch.sinceSeen ?? -1) / 2),
    roundLeft: Math.round((patch.roundLeft ?? 0) / 5),
    // Crossing into a new reading is exactly when the shot becomes legal, so
    // the bucket both throttles the feed and delivers the value in time.
    onTarget: aimBucket(patch.onTarget),
  });
}

export function createBot({ id, client, emit, aimSeconds = AIM_MIN_SECONDS, log, onDecision, onMove, memory }: BotOptions) {
  let actor: Actor<ReturnType<typeof createEnemyMachine>> | null = null;
  let state: MachineState = 'holding';
  let shots = 0;
  let seq = 0;
  let lastSync = '';
  /** One arrival per swing: set while not swinging, cleared on entering `peeking`. */
  let arrivalSent = true;
  let warnedNoAim = false;
  /** The weapon must be seen busy before it can be seen ready, or the first
   * `obs` after a shot (sent before the plugin registered it) ends the cycle. */
  let weaponBusySeen = false;
  const stats: BotStats = { decisions: 0, acted: 0, latencies: [] };
  const seenDecisions = new Set<number>();
  /** Persists across rounds; replaced, never mutated, so a round's requests stay stable. */
  let history: readonly string[] = [];
  let roundStartedAt = Date.now();
  let firstPeekS: number | null = null;
  let diedWhile: MachineState | null = null;

  const send = (fire: boolean) => {
    const intent: Intent = { t: 'intent', bot: id, state, fire, seq: ++seq };
    emit(intent);
  };

  const watchJev = () => {
    const jev = actor?.getSnapshot().children.jev as { subscribe?: (fn: (s: any) => void) => void } | undefined;
    jev?.subscribe?.((s: any) => {
      for (const d of [...(s.context.decisions as JevDecision[])].reverse()) {
        if (seenDecisions.has(d.at)) continue;
        seenDecisions.add(d.at);
        stats.decisions++;
        if (d.event) stats.acted++;
        if (!d.cached && !d.mock) stats.latencies.push(d.latencyMs);
        onDecision?.(d);
        log?.(`bot ${id} jev ${d.reason}: ${d.event?.type ?? '—'} ${Math.round(d.confidence * 100)}%${d.cached ? ' (cached)' : ` ${d.latencyMs}ms`}`);
      }
    });
  };

  /** A round is a fresh actor: final states cannot be re-entered. */
  function start() {
    actor?.stop();
    state = 'holding';
    shots = 0;
    lastSync = '';
    arrivalSent = true;
    weaponBusySeen = false;
    roundStartedAt = Date.now();
    firstPeekS = null;
    diedWhile = null;
    actor = createActor(createEnemyMachine(client, {
      peekMs: PEEK_SAFETY_MS,
      boltMs: BOLT_SAFETY_MS,
      aimSeconds,
      aimSettledSeconds: AIM_SETTLED_SECONDS,
      ...(memory ? { memory: () => history } : {}),
    }));
    actor.subscribe((snapshot) => {
      const value = String(snapshot.value) as MachineState;
      const fired = snapshot.context.shots > shots;
      shots = snapshot.context.shots;
      if (fired) weaponBusySeen = false;
      if (value === 'peeking' && value !== state) arrivalSent = false;
      if (value === 'peeking' && firstPeekS === null) firstPeekS = (Date.now() - roundStartedAt) / 1000;
      if (value === state && !fired) return;
      if (value !== state) log?.(`bot ${id} ${state} -> ${value}`);
      onMove?.({ from: state, to: value, fired });
      state = value;
      send(fired);
    });
    actor.start();
    watchJev();
    send(false);
  }

  function applyObs(obs: Obs) {
    if (!actor || actor.getSnapshot().status !== 'active') return;
    const patch: Partial<EnemyContext> = {
      hp: obs.hp,
      playerVisible: obs.visible,
      playerMoving: obs.moving,
      playerDistance: obs.dist,
      playerHp: obs.enemyHp,
      heardFootsteps: obs.footsteps,
      sinceSeen: obs.sinceSeen,
      onTarget: obs.onTarget ?? 0,
      roundLeft: obs.roundLeft,
    };
    if (obs.onTarget === undefined && !warnedNoAim) {
      warnedNoAim = true;
      log?.(`bot ${id} plugin is not reporting onTarget: aim never settles, so the bot will never fire`);
    }
    const key = syncKey(patch);
    if (key !== lastSync) {
      lastSync = key;
      actor.send({ type: 'world.sync', ...patch });
    }
    // The engine owns these two, so they are events rather than context. Sent
    // on the edge only: an event the machine ignores still wakes the agent, and
    // at 20Hz that would keep resetting its settle window so it never decides.
    if (state === 'peeking' && obs.atWaypoint === 'peek' && !arrivalSent) {
      arrivalSent = true;
      actor.send({ type: 'world.arrived' });
    }
    if (!obs.weaponReady) weaponBusySeen = true;
    else if (weaponBusySeen && state === 'cycling') {
      weaponBusySeen = false;
      actor.send({ type: 'world.weaponReady' });
    }
  }

  function handle(packet: Inbound) {
    if (packet.t === 'round_start') return start();
    if (!actor) start();
    if (packet.t === 'obs') return applyObs(packet);
    if (packet.t === 'bot_died') diedWhile = state;
    // Recorded even after the actor finished: the result is the plugin's to give.
    if (packet.t === 'round_end') history = [...history, roundSummary(firstPeekS, packet.result, diedWhile)].slice(-MEMORY_ROUNDS);
    if (actor!.getSnapshot().status !== 'active') return;
    if (packet.t === 'bot_died') actor!.send({ type: 'world.enemyDead' });
    else if (packet.t === 'enemy_died') actor!.send({ type: 'world.playerDead' });
    else if (packet.t === 'round_end') actor!.send({ type: 'world.roundOver' });
  }

  return {
    id,
    handle,
    start,
    /** 1Hz keepalive so the plugin always knows the current state. */
    heartbeat: () => send(false),
    state: () => state,
    history: () => history,
    stats: () => ({ ...stats, latencies: [...stats.latencies] }),
    stop: () => actor?.stop(),
  };
}

export type Bot = ReturnType<typeof createBot>;
