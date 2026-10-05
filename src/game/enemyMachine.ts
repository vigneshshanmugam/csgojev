import { setup, types } from 'xstate';
import { z } from 'zod';
import { createJevLogic, type JevClient } from '@xstate/jev';

/** Time to swing from behind the pillar out into the lane. The game lerps over the same window. */
export const PEEK_MS = 550;
/** AWP bolt cycle after a shot. */
export const BOLT_MS = 1500;
/** Reflex: nobody holds a wide open angle forever. */
export const EXPOSED_MS = 5000;

/**
 * What a real engine owns and the prototype does not. The Three.js renderer
 * reports neither arrival nor weapon state nor time on target, so there the
 * timers are the truth and the aim gate is off; against CS the plugin sends
 * `world.arrived` / `world.weaponReady` and `onTarget`, the timers are raised
 * to safety nets, and aim becomes a condition of firing. `EXPOSED_MS` is never
 * overridden: it is a reflex, not physics.
 */
export interface EnemyTiming {
  peekMs?: number;
  boltMs?: number;
  /**
   * Seconds the crosshair must have been on the player before `enemy.shoot` is
   * legal at all. 0 (the default) is no gate, for engines that cannot report it.
   */
  aimSeconds?: number;
  /** Seconds at which aim is fully settled. Only describes the shot to Jev. Defaults to twice `aimSeconds`. */
  aimSettledSeconds?: number;
  /**
   * How earlier rounds against this opponent went, one line each, newest last.
   * Shown to Jev when given, so it can drop a plan that keeps losing.
   */
  memory?: () => readonly string[];
  /** When set, the bot chooses which lane to peek instead of a single shared peek. */
  sides?: readonly ['left', 'right'];
}

/**
 * What the game tells the bot about the world. The bot's own movement is not
 * in here on purpose: the machine's state says it (`peeking` is moving,
 * `scoped` is standing still), so the two can never disagree.
 */
export interface EnemyContext {
  hp: number;
  shots: number;
  playerVisible: boolean;
  playerMoving: boolean;
  playerDistance: number;
  playerHp: number;
  /** The player is running close enough to be heard, even through a wall. */
  heardFootsteps: boolean;
  /** Seconds since the player was last in sight; -1 if never. */
  sinceSeen: number;
  /**
   * Seconds the bot's crosshair has been settled on the player, 0 when it is
   * not on them. Perception, like the rest of this: the engine measures it.
   * Engines that cannot stay at 0 and leave the aim gate off.
   */
  onTarget: number;
  /** Seconds left in the round. The attacker has to come to you before it runs out. */
  roundLeft: number;
  /** Which side the bot is currently contesting, on split-lane maps. */
  side?: 'left' | 'right';
  /** Side footsteps came from, when the engine can tell. */
  footstepsFrom?: 'left' | 'right' | null;
  /** Where the player was last seen, when the engine can tell. */
  lastSeenSide?: 'left' | 'right' | null;
}

export const enemyInitial: EnemyContext = {
  hp: 100,
  shots: 0,
  playerVisible: false,
  playerMoving: false,
  // The lane is ~23m and the round is 45s. Kept as literals, not imports: this
  // file depends on nothing but xstate, zod and @xstate/jev so it can move into
  // the sidecar unchanged. `ROUND_SECONDS` in combat.ts must agree.
  playerDistance: 23,
  playerHp: 100,
  heardFootsteps: false,
  sinceSeen: -1,
  onTarget: 0,
  roundLeft: 45,
};

const events = {
  'enemy.peek': z.object({}).describe('Swing out from behind the pillar into the lane. Takes 0.55s, and you are moving and exposed the whole way, so you cannot shoot accurately until you stop.'),
  'enemy.peekLeft': z.object({}).describe('Swing out from behind the pillar to contest the left lane. Takes 0.55s, and you are moving and exposed the whole way, so you cannot shoot accurately until you stop.'),
  'enemy.peekRight': z.object({}).describe('Swing out from behind the pillar to contest the right lane. Takes 0.55s, and you are moving and exposed the whole way, so you cannot shoot accurately until you stop.'),
  'enemy.counterStrafe': z.object({}).describe('Stop dead where you are, part way out. Less of you is exposed than a full swing, and you are accurate at once.'),
  'enemy.shoot': z.object({}).describe('Fire the AWP at the player. One hit kills. Then a 1.5s bolt cycle during which you cannot shoot.'),
  'enemy.fallBack': z.object({}).describe('Step back behind the pillar, out of sight and safe.'),
  'world.sync': types<Partial<EnemyContext>>(),
  /** The bot physically reached the peek waypoint. Only a real engine sends this. */
  'world.arrived': types<Record<string, never>>(),
  /** The real weapon finished its bolt cycle. Only a real engine sends this. */
  'world.weaponReady': types<Record<string, never>>(),
  'world.enemyDead': types<Record<string, never>>(),
  'world.playerDead': types<Record<string, never>>(),
  'world.roundOver': types<Record<string, never>>(),
};

const SYS = [
  'You are a pro CS AWPer holding the A-long angle. A human rifler is pushing down the corridor at you.',
  'One AWP hit kills them. Three of their rifle body shots kill you, so every second you spend exposed is a risk.',
  'Shots you take while moving miss; stationary shots hit. After you fire you cannot shoot for 1.5 seconds.',
  'Behind the pillar you are safe but blind, and you cannot win from there. The rifler is walking down the lane to clear your angle:',
  'once they are close enough to see around the pillar they get the first shot, and holding is no longer safe, it is lost.',
  'So waiting has a price. Take the angle while they are still far enough away that you can see them before they can see you,',
  'then stop, kill, and get back behind cover before anyone trades with you.',
  'Read the cues. Footsteps mean they are close and running. A long time without seeing them means they are closing in silence.',
  'If the round timer runs out you have thrown the round by never contesting.',
].join(' ');

/**
 * What the aim gate adds to the brief. Only engines that report `onTarget`
 * say this, and it corrects what `enemy.counterStrafe` promises: stopping is
 * necessary for a shot, but it is not instantly sufficient.
 */
const AIM_SYS = [
  'Your scope takes a moment to settle after you stop moving, and it resets whenever you lose sight of them.',
  'Until it has settled there is no shot to take at all. Half settled you can fire, but it is a gamble that costs you the bolt cycle;',
  'fully settled it is a kill. The aim cue tells you which you are holding.',
].join(' ');

const MEMORY_SYS = [
  'You play this same opponent round after round. earlierRounds says how your last rounds went: how you opened and how each ended.',
  'Opponents differ: some push into you, some hold their own angle and punish an early peek. If a plan keeps losing, change it.',
].join(' ');

const SPLIT_SYS = [
  'You are a pro CS AWPer holding the middle of a two-lane angle. A human rifler can come through the left lane or the right lane.',
  'One AWP hit kills them. Three of their rifle body shots kill you, so every second you spend exposed is a risk.',
  'Shots you take while moving miss; stationary shots hit. After you fire you cannot shoot for 1.5 seconds.',
  'Behind the pillar you are safe but blind, and you cannot win from there. A peek contests only one lane at a time.',
  'If you pick the empty lane, the rifler in the other lane keeps closing distance. If the round timer runs out you have thrown the round by never contesting.',
  'Choose when to leave cover, which lane to contest, when to stop, when to shoot, and when to get back behind cover.',
].join(' ');

/**
 * Distance in 2m steps: enough for a tactical read, coarse enough that the
 * request is stable. 5m was right for the 68m lane; on a 23m one it left only
 * five readings between spawn and contact, and the decision that matters —
 * peek now, while they are still too far to clear the angle, or hold — turns
 * on a few metres. Anything that dedupes world syncs has to round the same way
 * or a change Jev would act on never reaches it.
 */
const metres = (d: number) => Math.round(d / 2) * 2;

export function createEnemyMachine(client: JevClient, timing: EnemyTiming = {}) {
  const peekMs = timing.peekMs ?? PEEK_MS;
  const boltMs = timing.boltMs ?? BOLT_MS;
  const aimSeconds = timing.aimSeconds ?? 0;
  const aimSettled = timing.aimSettledSeconds ?? aimSeconds * 2;
  const split = !!timing.sides;
  /** Four readings, not a number that never stops changing: the request stays stable. */
  const aimOf = (onTarget: number) =>
    onTarget <= 0 ? 'not on them' : onTarget < aimSeconds ? 'still settling, no shot yet'
      : onTarget < aimSettled ? 'half settled, a rushed shot' : 'settled, your best shot';
  const sync = ({ context, event }: { context: EnemyContext; event: { type: 'world.sync' } & Partial<EnemyContext> }) => {
    const { type: _t, ...patch } = event;
    return { context: { ...context, ...patch } };
  };
  const common = {
    'world.sync': sync,
    'world.enemyDead': { target: 'dead' },
    'world.playerDead': { target: 'victory' },
    'world.roundOver': { target: 'timeout' },
  } as const;
  /**
   * Firing at nothing is not a move, and neither is firing before the scope
   * has settled: both are physics, so the machine refuses them and Jev is
   * never offered a shot it cannot make.
   */
  const shoot = ({ context }: { context: EnemyContext }) =>
    context.playerVisible && context.onTarget >= aimSeconds
      ? { target: 'cycling', context: { ...context, shots: context.shots + 1 } }
      : undefined;
  const fallBack = ({ context }: { context: EnemyContext }) => ({ target: 'holding', context: { ...context, side: undefined } });
  const peekSide = (side: 'left' | 'right', target: 'peekingLeft' | 'peekingRight') =>
    ({ context }: { context: EnemyContext }) => ({ target, context: { ...context, side } });
  const peekingState = {
    description: 'Swinging out into a lane. Exposed and moving, so you cannot hit anything yet.',
    on: {
      ...common,
      'enemy.counterStrafe': { target: 'scoped' },
      'enemy.shoot': shoot,
      'enemy.fallBack': fallBack,
      'world.arrived': { target: 'scoped' },
    },
    // The swing finishes on its own: fully out, and standing still.
    after: { [peekMs]: { target: 'scoped' } },
  } as const;

  return setup({
    actors: {
      jev: createJevLogic({
        events: 'enemy.*',
        instructions: [split ? SPLIT_SYS : SYS, aimSeconds > 0 ? AIM_SYS : '', timing.memory ? MEMORY_SYS : ''].filter(Boolean).join(' '),
        noop: 'stay behind the pillar and wait. Nothing can hit you, but you see nothing, you cannot shoot, and the rifler walks a few metres closer to clearing your angle.',
        client,
        lookahead: true,
        // A slow tactical brain on top of a fast game: throttled, and given a
        // moment for the world to settle before it commits to a read. Holding
        // an empty angle is cheap to re-ask about, so it backs off further.
        interval: ({ decision }) => (decision.event ? 250 : 900),
        settle: 120,
        // Circling is normal here: peek, look, fall back, peek again. Worth
        // telling Jev about (the default), not worth shouting about.
        loops: { onLoop: (loop) => console.debug(`[jev] ${loop.message}`) },
        state: (snapshot: any) => {
          const c = snapshot.context as EnemyContext;
          return {
            you: snapshot.value,
            playerInSight: c.playerVisible,
            // Shown only when the engine measures it: the machine already
            // refuses an unsettled shot, but waiting is a different decision
            // when a shot is one beat away than when there is nothing coming.
            ...(aimSeconds > 0 ? { aim: aimOf(c.onTarget) } : {}),
            playerMoving: c.playerMoving,
            playerDistanceM: metres(c.playerDistance),
            footstepsHeard: c.heardFootsteps,
            secondsSincePlayerSeen: c.sinceSeen < 0 ? 'never seen this round' : Math.round(c.sinceSeen),
            yourHp: c.hp,
            playerHp: c.playerHp,
            roundSecondsLeft: Math.round(c.roundLeft / 5) * 5,
            ...(split ? {
              side: c.side ?? 'behind cover',
              footstepsFrom: c.footstepsFrom ?? 'none',
              playerLastSeenOn: c.lastSeenSide ?? (c.sinceSeen < 0 ? 'never seen this round' : 'unknown'),
            } : {}),
            ...(timing.memory ? { earlierRounds: timing.memory().length ? timing.memory() : 'none yet' } : {}),
          };
        },
      }),
    },
  }).createMachine({
    schemas: { context: types<EnemyContext>(), events },
    context: enemyInitial,
    invoke: { src: 'jev', id: 'jev' },
    initial: 'holding',
    states: {
      holding: {
        description: 'Behind the pillar, out of sight, AWP ready. Nothing can hit you here.',
        on: split
          ? {
              ...common,
              'enemy.peekLeft': peekSide('left', 'peekingLeft'),
              'enemy.peekRight': peekSide('right', 'peekingRight'),
            }
          : { ...common, 'enemy.peek': { target: 'peeking' } },
      },
      peeking: peekingState,
      peekingLeft: peekingState,
      peekingRight: peekingState,
      scoped: {
        description: 'Exposed, scoped in and standing still. Your shot is accurate; so is theirs.',
        on: { ...common, 'enemy.shoot': shoot, 'enemy.fallBack': fallBack },
        // Reflex, not a decision: stop baking in the open.
        after: { [EXPOSED_MS]: fallBack },
      },
      cycling: {
        description: 'Just fired, bolt cycling. You cannot shoot until it is done.',
        on: { ...common, 'enemy.fallBack': fallBack, 'world.weaponReady': { target: 'scoped' } },
        after: { [boltMs]: { target: 'scoped' } },
      },
      dead: { type: 'final' },
      victory: { type: 'final' },
      timeout: { type: 'final' },
    },
  });
}
