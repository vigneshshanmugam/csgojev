import { describe, expect, it } from 'vitest';
import { ACQUIRE_SECONDS, AWP_DMG, MIN_AIM_SECONDS, aimBucket, RIFLE_BODY, RIFLE_HEAD, awpHitChance, playerSpread } from './combat';

describe('duel resolution', () => {
  it('kills the player in one AWP hit and the bot in three body shots', () => {
    expect(AWP_DMG).toBeGreaterThanOrEqual(100);
    expect(RIFLE_BODY * 2).toBeLessThan(100);
    expect(RIFLE_BODY * 3).toBeGreaterThanOrEqual(100);
    expect(RIFLE_HEAD).toBeGreaterThanOrEqual(100);
  });

  it('makes a standing rifle shot a laser and a running one a spray', () => {
    const standing = playerSpread(0);
    const running = playerSpread(5.5);
    expect(standing).toBeLessThan(0.002);
    expect(running).toBeGreaterThan(standing * 20);
  });

  it('punishes the bot for firing mid-swing far harder than it rewards a still target', () => {
    const aimed = { playerSpeed: 0, onTarget: 5 };
    const settled = awpHitChance({ enemyMoving: false, ...aimed });
    const swinging = awpHitChance({ enemyMoving: true, ...aimed });
    expect(settled).toBeGreaterThan(0.9);
    expect(swinging).toBeLessThan(0.25);
    // Counter-strafing is always worth more than catching the player moving.
    expect(awpHitChance({ enemyMoving: false, playerSpeed: 5.5, onTarget: 5 })).toBeGreaterThan(swinging);
  });

  it('gives the player a reaction window: the AWPer has to find them before it can kill them', () => {
    const at = (onTarget: number) => awpHitChance({ enemyMoving: false, playerSpeed: 0, onTarget });
    // Stepping into the open is survivable for a beat, not a coin flip you always lose.
    expect(at(0)).toBeLessThan(0.2);
    expect(at(ACQUIRE_SECONDS / 2)).toBeLessThan(0.6);
    expect(at(ACQUIRE_SECONDS)).toBeGreaterThan(0.9);
    // Long after acquiring, standing in the open is still fatal.
    expect(at(10)).toBe(at(ACQUIRE_SECONDS));
  });

  it('buckets aim into the four readings Jev is shown', () => {
    expect([0, MIN_AIM_SECONDS / 2, MIN_AIM_SECONDS, ACQUIRE_SECONDS].map(aimBucket)).toEqual([0, 1, 2, 3]);
  });
});
