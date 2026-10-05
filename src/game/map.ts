/** A-long style corridor. x: left/right, z: forward is -z. All boxes taller than eye height, so LOS is 2D. */
export interface Box { x0: number; x1: number; z0: number; z1: number; h: number; color: number }

const W = 3.5; // half corridor width
export const BOXES: Box[] = [
  { x0: -W - 1, x1: -W, z0: -24, z1: 6, h: 5, color: 0xb59a6b }, // left wall
  { x0: W, x1: W + 1, z0: -24, z1: 6, h: 5, color: 0xb59a6b }, // right wall
  { x0: -W - 1, x1: W + 1, z0: 6, z1: 7, h: 5, color: 0xa88e60 }, // back wall behind spawn
  { x0: -W - 1, x1: W + 1, z0: -25, z1: -24, h: 5, color: 0xa88e60 }, // far wall
  { x0: -W, x1: -0.9, z0: -19, z1: -18, h: 3, color: 0x8a7348 }, // enemy corner pillar (cover)
  { x0: 1.5, x1: W, z0: -3, z1: -1.8, h: 2.2, color: 0x6b5a3a }, // crate, player cover
  { x0: -W, x1: -1.75, z0: -10, z1: -8.5, h: 2.2, color: 0x6b5a3a }, // crate, mid cover
  // Kept left of the peek lane: a crate across the middle would block the duel itself.
  { x0: -3.2, x1: -1, z0: -14.6, z1: -13.8, h: 2.2, color: 0x6b5a3a }, // crate, far mid
];

/** Tucked behind the right-hand crate, out of the AWP line: stepping into the lane is the player's choice to make. */
export const PLAYER_SPAWN = { x: 2.3, z: 3 };
export const ENEMY_HOLD = { x: -2.2, z: -20 };
export const ENEMY_PEEK = { x: 0.9, z: -20 };
export const EYE = 1.6;

/** Spawn to the AWPer, down the lane. The round timer and the fog are sized off this. */
export const LANE_M = PLAYER_SPAWN.z - ENEMY_HOLD.z;
/** Half the clear width between the side walls. The CS map spreads its spawn points inside this. */
export const HALF_WIDTH = W;

/**
 * Scripted attacker paths, in map metres. They live here rather than next to
 * each simulation because they are map geometry: move a crate and they have to
 * move with it. The headless duel and the sidecar's fake plugin share them.
 */
export type Behaviour = 'rusher' | 'holder' | 'jiggler';
export const ROUTES: Record<Behaviour, Array<{ x: number; z: number }>> = {
  rusher: [{ x: 0, z: 1.5 }, { x: 0, z: -12 }, { x: 2.4, z: -17 }],
  holder: [{ x: 2.5, z: -1.2 }], // never leaves cover: the stalemate case
  jiggler: [{ x: 0, z: 1.5 }, { x: 0, z: -12 }, { x: 0.8, z: -13.2 }],
};
/** Where the jiggler sits once it has walked its route, and how far it steps either way. */
export const JIGGLE = { x: 0.8, z: -13.2, amplitude: 2.7 };

/** Does the 2D segment a->b cross any box? */
export function blocked(ax: number, az: number, bx: number, bz: number, boxes: readonly Box[] = BOXES): boolean {
  for (const b of boxes) if (segHitsBox(ax, az, bx, bz, b)) return true;
  return false;
}

function segHitsBox(ax: number, az: number, bx: number, bz: number, b: Box): boolean {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  for (const [p, q] of [[-dx, ax - b.x0], [dx, b.x1 - ax], [-dz, az - b.z0], [dz, b.z1 - az]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/** Push a circle out of boxes. */
export function collide(x: number, z: number, r: number, boxes: readonly Box[] = BOXES): { x: number; z: number } {
  for (const b of boxes) {
    const cx = Math.max(b.x0, Math.min(x, b.x1));
    const cz = Math.max(b.z0, Math.min(z, b.z1));
    const dx = x - cx, dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-8) { const d = Math.sqrt(d2); x = cx + (dx / d) * r; z = cz + (dz / d) * r; }
      else {
        // Dead centre inside the box: out through the nearest face, never the far one.
        const out = [b.x0 - r - x, b.x1 + r - x, b.z0 - r - z, b.z1 + r - z];
        const i = out.reduce((best, v, j) => (Math.abs(v) < Math.abs(out[best]) ? j : best), 0);
        if (i < 2) x += out[i]; else z += out[i];
      }
    }
  }
  return { x, z };
}
