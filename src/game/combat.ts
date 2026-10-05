/** Duel resolution, kept out of the renderer so the headless sim and the game agree on the numbers. */

/** CS 1.6 numbers. The player carries an AK-47, the bot an AWP. */
export const AWP_DMG = 115; // one hit, anywhere
export const RIFLE_BODY = 36; // AK-47, three to kill
export const RIFLE_HEAD = 144; // AK-47 headshot, x4
export const MAG = 30;
export const RESERVE = 90;
export const RELOAD_MS = 2450;
/** AK-47 fire interval, 600 rounds a minute. */
export const FIRE_INTERVAL_MS = 100;
/**
 * The lane is ~23m, so an attacker who simply walks it arrives in about four
 * seconds. 45s is roughly ten traverses: long enough for the peek / fall back /
 * re-peek cycle to play out several times, short enough that never contesting
 * is a losing choice rather than a free minute of standing still.
 */
export const ROUND_SECONDS = 45;

/** Rifle cone in radians. Standing still is a laser; running is not. */
export function playerSpread(speed: number): number {
  return 0.0015 + 0.009 * speed;
}

/** How long the AWPer must have been looking at the player before the shot is a real shot. */
export const ACQUIRE_SECONDS = 0.7;

/**
 * Below half-acquired the shot is not a shot, it is throwing away the bolt
 * cycle. Engines that report time on target refuse `enemy.shoot` under this,
 * so a rushed shot stays available but a hopeless one is never on the menu.
 */
export const MIN_AIM_SECONDS = ACQUIRE_SECONDS / 2;

/**
 * Chance the AWP shot lands. Firing mid-swing is the expensive mistake, and a
 * moving target is worth something. The big one is time on target: an AWPer
 * who has just been shown a player has to flick onto them and settle first,
 * which is the window the player gets to react, stop and shoot back.
 */
export function awpHitChance({ enemyMoving, playerSpeed, onTarget }: {
  enemyMoving: boolean;
  playerSpeed: number;
  /** Seconds the player has been continuously in sight. */
  onTarget: number;
}): number {
  const aim = Math.min(1, Math.max(0, onTarget) / ACQUIRE_SECONDS);
  return (enemyMoving ? 0.18 : 0.92) * (playerSpeed > 1 ? 0.7 : 1) * (0.15 + 0.85 * aim);
}

/** The four aim readings the machine shows Jev, so feeds only resync when one changes. */
export function aimBucket(onTarget = 0): 0 | 1 | 2 | 3 {
  if (onTarget <= 0) return 0;
  if (onTarget < MIN_AIM_SECONDS) return 1;
  return onTarget < ACQUIRE_SECONDS ? 2 : 3;
}
