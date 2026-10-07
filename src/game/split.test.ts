import { describe, expect, it } from 'vitest';
import { blocked, collide } from './map';
import { SPLIT_BOXES, SPLIT_HOLD, SPLIT_PEEK_L, SPLIT_PEEK_R, SPLIT_ROUTES, SPLIT_SPAWN } from './split';

const los = (a: { x: number; z: number }, b: { x: number; z: number }) => !blocked(a.x, a.z, b.x, b.z, SPLIT_BOXES);
const inside = (p: { x: number; z: number }) =>
  SPLIT_BOXES.some((b) => p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1);

describe('split layout line of sight', () => {
  it('keeps the AWPer hidden at the hold spot', () => {
    expect(los(SPLIT_SPAWN, SPLIT_HOLD)).toBe(false);
  });

  it('lets each peek see only its own lane', () => {
    for (const p of SPLIT_ROUTES.left) {
      expect(los(SPLIT_PEEK_L, p), `left peek to ${p.x}, ${p.z}`).toBe(true);
      expect(los(SPLIT_PEEK_R, p), `right peek to ${p.x}, ${p.z}`).toBe(false);
    }
    for (const p of SPLIT_ROUTES.right) {
      expect(los(SPLIT_PEEK_R, p), `right peek to ${p.x}, ${p.z}`).toBe(true);
      expect(los(SPLIT_PEEK_L, p), `left peek to ${p.x}, ${p.z}`).toBe(false);
    }
  });

  it('opens both lanes near the merge area', () => {
    expect(los(SPLIT_PEEK_L, { x: -1.8, z: -16.5 })).toBe(true);
    expect(los(SPLIT_PEEK_R, { x: 1.8, z: -16.5 })).toBe(true);
  });
});

describe('split layout collision', () => {
  it('leaves spawn, hold and peeks clear', () => {
    for (const p of [SPLIT_SPAWN, SPLIT_HOLD, SPLIT_PEEK_L, SPLIT_PEEK_R, ...SPLIT_ROUTES.left, ...SPLIT_ROUTES.right]) {
      expect(collide(p.x, p.z, 0.4, SPLIT_BOXES)).toEqual(p);
    }
  });

  it('lets both routes reach the merge area without getting stuck', () => {
    for (const route of Object.values(SPLIT_ROUTES)) {
      for (const p of route) expect(inside(collide(p.x, p.z, 0.4, SPLIT_BOXES))).toBe(false);
    }
  });
});

/** GoldSrc player hull half-width: 16 units. */
const HULL_HALF_M = 16 / 39.37;

/** Shortest distance from the segment ab to the box, sampled every 5cm (x/z plane). */
function clearance(a: { x: number; z: number }, b: { x: number; z: number }, box: { x0: number; x1: number; z0: number; z1: number }) {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(length / 0.05));
  let best = Infinity;
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const z = a.z + ((b.z - a.z) * i) / steps;
    const dx = Math.max(box.x0 - x, 0, x - box.x1);
    const dz = Math.max(box.z0 - z, 0, z - box.z1);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

const minClearance = (points: Array<{ x: number; z: number }>) => {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    for (const box of SPLIT_BOXES) best = Math.min(best, clearance(points[i], points[i + 1], box));
  }
  return best;
};

describe('split route hull clearance', () => {
  // A route that only passes a point test can still snag: with the legs at x=+-3.2 the zBot's hull
  // (about 0.41m) clipped the cover crates (x=+-3.6) and it stopped for good mid-lane.
  it('keeps every route segment a full hull away from every box', () => {
    for (const [name, route] of Object.entries(SPLIT_ROUTES)) {
      expect(minClearance([SPLIT_SPAWN, ...route]), `${name} route`).toBeGreaterThanOrEqual(HULL_HALF_M);
    }
  });

  it('would have caught the x=+-3.2 legs', () => {
    const snagged = [SPLIT_SPAWN, { x: 3.2, z: 2.5 }, { x: 3.2, z: -13 }, { x: 2.4, z: -17 }];
    expect(minClearance(snagged)).toBeLessThan(HULL_HALF_M);
    const snaggedLeft = [SPLIT_SPAWN, { x: -3.2, z: 2.5 }, { x: -3.2, z: -13 }, { x: -2.4, z: -17 }];
    expect(minClearance(snaggedLeft)).toBeLessThan(HULL_HALF_M);
  });
});
