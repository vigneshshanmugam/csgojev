import type { Box } from './map';

/** Two-lane duel. The zBot route chooses a lane; the AWPer chooses which lane to contest. */
export const SPLIT_BOXES: Box[] = [
  { x0: -7, x1: -6, z0: -24, z1: 6, h: 5, color: 0xb59a6b }, // left wall
  { x0: 6, x1: 7, z0: -24, z1: 6, h: 5, color: 0xb59a6b }, // right wall
  { x0: -7, x1: 7, z0: 6, z1: 7, h: 5, color: 0xa88e60 }, // back wall
  { x0: -7, x1: 7, z0: -25, z1: -24, h: 5, color: 0xa88e60 }, // far wall
  { x0: -0.5, x1: 0.5, z0: -18, z1: 0, h: 5, color: 0xa88e60 }, // lane divider
  { x0: -0.9, x1: 0.9, z0: -19, z1: -17, h: 3, color: 0x8a7348 }, // AWPer pillar
  { x0: -5.3, x1: -3.6, z0: -5.5, z1: -4.2, h: 2.2, color: 0x6b5a3a }, // left cover
  { x0: 3.6, x1: 5.3, z0: -5.5, z1: -4.2, h: 2.2, color: 0x6b5a3a }, // right cover
];

export const SPLIT_SPAWN = { x: 0, z: 3 };
export const SPLIT_HOLD = { x: 0, z: -20 };
export const SPLIT_PEEK_L = { x: -2.5, z: -20 };
export const SPLIT_PEEK_R = { x: 2.5, z: -20 };
export const SPLIT_EYE = 1.6;
export const SPLIT_LANE_M = SPLIT_SPAWN.z - SPLIT_HOLD.z;
export const SPLIT_HALF_WIDTH = 6;

export type SplitRoute = 'left' | 'right';
export const SPLIT_LEFT_0 = { x: -2.8, z: 2.5 };
export const SPLIT_LEFT_1 = { x: -2.8, z: -13 };
export const SPLIT_LEFT_2 = { x: -2.4, z: -17 };
export const SPLIT_RIGHT_0 = { x: 2.8, z: 2.5 };
export const SPLIT_RIGHT_1 = { x: 2.8, z: -13 };
export const SPLIT_RIGHT_2 = { x: 2.4, z: -17 };
export const SPLIT_ROUTES: Record<SplitRoute, Array<{ x: number; z: number }>> = {
  left: [SPLIT_LEFT_0, SPLIT_LEFT_1, SPLIT_LEFT_2],
  right: [SPLIT_RIGHT_0, SPLIT_RIGHT_1, SPLIT_RIGHT_2],
};
