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
