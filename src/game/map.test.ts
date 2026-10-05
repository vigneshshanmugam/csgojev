import { describe, expect, it } from 'vitest';
import { BOXES, ENEMY_HOLD, ENEMY_PEEK, PLAYER_SPAWN, blocked, collide } from './map';

const los = (a: { x: number; z: number }, b: { x: number; z: number }) => !blocked(a.x, a.z, b.x, b.z);
const inside = (p: { x: number; z: number }) => BOXES.some((b) => p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1);

describe('line of sight', () => {
  it('hides the AWPer behind the pillar while it holds', () => {
    expect(los(PLAYER_SPAWN, ENEMY_HOLD)).toBe(false);
  });

  it('spawns the player in cover, so walking into the AWP line is their decision', () => {
    expect(los(PLAYER_SPAWN, ENEMY_PEEK)).toBe(false);
  });

  it('opens the duel one step into the lane: the fight has to be reachable', () => {
    expect(los({ x: 0, z: 2 }, ENEMY_PEEK)).toBe(true);
  });

  it('stays open down the right half of the corridor, where the player pushes', () => {
    for (const z of [0, -3, -6, -9, -12, -15]) {
      expect(los({ x: 1, z }, ENEMY_PEEK), `x 1, z ${z}`).toBe(true);
    }
  });

  it('gives the player cover: behind the right crate nothing can see them', () => {
    expect(los({ x: 2.5, z: -1.2 }, ENEMY_PEEK)).toBe(false);
  });

  it('is symmetric', () => {
    expect(blocked(PLAYER_SPAWN.x, PLAYER_SPAWN.z, ENEMY_HOLD.x, ENEMY_HOLD.z))
      .toBe(blocked(ENEMY_HOLD.x, ENEMY_HOLD.z, PLAYER_SPAWN.x, PLAYER_SPAWN.z));
  });
});

describe('collision', () => {
  it('leaves spawn and both AWP positions clear', () => {
    for (const p of [PLAYER_SPAWN, ENEMY_HOLD, ENEMY_PEEK]) {
      expect(collide(p.x, p.z, 0.4)).toEqual({ x: p.x, z: p.z });
    }
  });

  it('pushes a player buried in a wall back out the near face, not through it', () => {
    const out = collide(3.7, -8, 0.4); // 0.2m inside the right wall, which runs x 3.5..4.5
    expect(out.x).toBeCloseTo(3.1);
    expect(inside(out)).toBe(false);
  });

  it('slides along a crate instead of letting the player through it', () => {
    const out = collide(2.5, -2.1, 0.4); // walked into the front face of the right crate
    expect(out.z).toBeCloseTo(-1.4);
    expect(inside(out)).toBe(false);
  });

  it('lets the player walk the corridor to the enemy without getting stuck', () => {
    let x = 0, z = PLAYER_SPAWN.z;
    for (let i = 0; i < 2000 && z > -16; i++) {
      const next = collide(x, z - 0.05, 0.4);
      x = next.x; z = next.z;
      expect(inside(next)).toBe(false);
    }
    expect(z).toBeLessThan(-16);
  });
});
