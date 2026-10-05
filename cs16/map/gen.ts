/**
 * Emits jev_duel.map (Valve 220) from the play-tested prototype geometry in
 * src/game/map.ts. The level design lives there; this file only converts units
 * and wraps the lane in a sealed shell.
 *
 * Prototype axes: x = left/right, z = forward (-z is downrange), y implicit up.
 * GoldSrc axes:   x = left/right, y = forward,                  z = up.
 * So map_x = proto_x * U, map_y = proto_z * U, map_z = height * U.
 * No translation is applied, so a prototype metre coordinate converts to a
 * GoldSrc coordinate by multiplying by U and nothing else.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BOXES, PLAYER_SPAWN, ENEMY_HOLD, ENEMY_PEEK, EYE, HALF_WIDTH, LANE_M, blocked, collide, type Box } from '../../src/game/map.js';
import { SPLIT_BOXES, SPLIT_EYE, SPLIT_HALF_WIDTH, SPLIT_HOLD, SPLIT_LANE_M, SPLIT_PEEK_L, SPLIT_PEEK_R, SPLIT_SPAWN } from '../../src/game/split.js';

/** Units per metre. 1 GoldSrc unit ~= 1 inch. */
const U = 39.37;
const u = (m: number) => Math.round(m * U);
const layoutName = (process.argv[2] ?? 'duel').replace(/^jev_/, '');
if (!['duel', 'split'].includes(layoutName)) throw new Error('layout must be duel or split');
const layout = layoutName === 'split'
  ? {
      map: 'jev_split',
      boxes: SPLIT_BOXES,
      spawn: SPLIT_SPAWN,
      hold: SPLIT_HOLD,
      peeks: [SPLIT_PEEK_L, SPLIT_PEEK_R],
      eye: SPLIT_EYE,
      halfWidth: SPLIT_HALF_WIDTH,
      laneM: SPLIT_LANE_M,
    }
  : {
      map: 'jev_duel',
      boxes: BOXES,
      spawn: PLAYER_SPAWN,
      hold: ENEMY_HOLD,
      peeks: [ENEMY_PEEK],
      eye: EYE,
      halfWidth: HALF_WIDTH,
      laneM: LANE_M,
    };

const TEX = {
  floor: 'SandRoad',
  ceiling: 'SandCCrete',
  wall: 'csSandWall2',
  pillar: 'SandCCrete',
  crateSide: 'SandCrtLrgSd',
  crateTop: 'SandCrtLrgTp',
} as const;

const SHELL = 16; // thickness of floor/ceiling slabs
const SPAWN_Z = 40; // player origin height above the floor
const HULL = 20; // half a CS player hull plus slack, so spawns never clip a wall
const SPAWN_GAP = 60; // between adjacent spawn points: a hull is 32 wide

type Vec = [number, number, number];
interface Face {
  p: [Vec, Vec, Vec];
  tex: string;
  uAxis: Vec;
  vAxis: Vec;
}

/** Axis-aligned box. Point winding gives outward normals under hlcsg's
 *  n = (p0-p1) x (p2-p1) convention. */
function box(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  side: string, cap = side,
): string {
  const X: Vec = [1, 0, 0], Y: Vec = [0, 1, 0], nY: Vec = [0, -1, 0], nZ: Vec = [0, 0, -1];
  const faces: Face[] = [
    { p: [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1]], tex: cap, uAxis: X, vAxis: nY }, // +Z
    { p: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0]], tex: cap, uAxis: X, vAxis: nY }, // -Z
    { p: [[x0, y1, z1], [x0, y0, z1], [x0, y0, z0]], tex: side, uAxis: Y, vAxis: nZ }, // -X
    { p: [[x1, y1, z0], [x1, y0, z0], [x1, y0, z1]], tex: side, uAxis: Y, vAxis: nZ }, // +X
    { p: [[x1, y1, z1], [x0, y1, z1], [x0, y1, z0]], tex: side, uAxis: X, vAxis: nZ }, // +Y
    { p: [[x1, y0, z0], [x0, y0, z0], [x0, y0, z1]], tex: side, uAxis: X, vAxis: nZ }, // -Y
  ];
  const lines = faces.map((f) => {
    const pts = f.p.map(([a, b, c]) => `( ${a} ${b} ${c} )`).join(' ');
    const ax = (v: Vec) => `[ ${v[0]} ${v[1]} ${v[2]} 0 ]`;
    return `${pts} ${f.tex} ${ax(f.uAxis)} ${ax(f.vAxis)} 0 1 1`;
  });
  return `{\n${lines.map((l) => `  ${l}`).join('\n')}\n}`;
}

/** By rank, not by absolute height: the shell is the tallest tier, the pillar the next. */
const WALL_H = Math.max(...layout.boxes.map((b) => b.h));
const PILLAR_H = Math.max(...layout.boxes.filter((b) => b.h < WALL_H).map((b) => b.h));

function texFor(b: Box): { side: string; cap: string } {
  if (b.h === WALL_H) return { side: TEX.wall, cap: TEX.wall };
  if (b.h === PILLAR_H) return { side: TEX.pillar, cap: TEX.pillar };
  return { side: TEX.crateSide, cap: TEX.crateTop };
}

function ent(classname: string, kv: Record<string, string>): string {
  const pairs = Object.entries({ classname, ...kv })
    .map(([k, v]) => `  "${k}" "${v}"`)
    .join('\n');
  return `{\n${pairs}\n}`;
}

// --- outer extents, straight from BOXES ---------------------------------
const minX = u(Math.min(...layout.boxes.map((b) => b.x0)));
const maxX = u(Math.max(...layout.boxes.map((b) => b.x1)));
const minY = u(Math.min(...layout.boxes.map((b) => b.z0)));
const maxY = u(Math.max(...layout.boxes.map((b) => b.z1)));
const ceilZ = u(Math.max(...layout.boxes.map((b) => b.h)));

const brushes: string[] = [
  box(minX, minY, -SHELL, maxX, maxY, 0, TEX.floor),
  box(minX, minY, ceilZ, maxX, maxY, ceilZ + SHELL, TEX.ceiling),
  ...layout.boxes.map((b) => {
    const t = texFor(b);
    return box(u(b.x0), u(b.z0), 0, u(b.x1), u(b.z1), u(b.h), t.side, t.cap);
  }),
];

const worldspawn = [
  '{',
  '  "classname" "worldspawn"',
  '  "mapversion" "220"',
  '  "wad" "/wads/sdhlt.wad;/wads/cs_dust.wad"',
  '  "MaxRange" "8192"',
  ...brushes.map((b) => b.split('\n').map((l) => `  ${l}`).join('\n')),
  '}',
].join('\n');

// --- entities -----------------------------------------------------------
// CT (info_player_start) at the prototype player spawn, facing downrange (-y).
// T (info_player_deathmatch) at the enemy hold/peek end, facing +y.
const ctY = u(layout.spawn.z);
const tY = u(layout.hold.z);
const lim = Math.floor(layout.halfWidth * U) - HULL;
const clampX = (x: number) => Math.max(-lim, Math.min(lim, x));
// The zBot spawns on these. Start at the first x where the whole hull is in
// view of at least one peek spot, or a held zBot can create uninformative draws.
const inView = (x: number) =>
  [x - HULL, x + HULL].every((e) => layout.peeks.some((p) => !blocked(p.x, p.z, e / U, layout.spawn.z, layout.boxes)));
let ctRight = clampX(u(layout.spawn.x));
while (!inView(ctRight)) {
  if (--ctRight < -lim) throw new Error('no CT spawn x is in view of the peek spot');
}
const ctXs = [0, 1, 2, 3].map((i) => clampX(ctRight - i * SPAWN_GAP));
// The spots the duel is built around first, then fillers in the gap between them.
const tSeeds = [layout.hold.x, ...layout.peeks.map((p) => p.x), layout.hold.x + SPAWN_GAP / U];
const tXs = tSeeds.slice(0, 4).map((x) => clampX(u(x)));

// A spawn inside a brush is a map that boots and then kills whoever joins.
for (const [x, y] of [...ctXs.map((x) => [x, ctY]), ...tXs.map((x) => [x, tY])]) {
  const m = collide(x / U, y / U, HULL / U, layout.boxes);
  if (Math.abs(m.x - x / U) > 1e-9 || Math.abs(m.z - y / U) > 1e-9) {
    throw new Error(`spawn ${x} ${y} is inside geometry; it would be pushed to ${u(m.x)} ${u(m.z)}`);
  }
}

const entities: string[] = [
  worldspawn,
  ...ctXs.map((x) => ent('info_player_start', { origin: `${x} ${ctY} ${SPAWN_Z}`, angles: '0 270 0' })),
  ...tXs.map((x) => ent('info_player_deathmatch', { origin: `${x} ${tY} ${SPAWN_Z}`, angles: '0 90 0' })),
];

// A light every ~250 units down the lane, just under the ceiling.
for (let y = maxY - 150; y > minY; y -= 250) {
  entities.push(ent('light', { origin: `0 ${Math.round(y)} ${ceilZ - 24}`, _light: '255 238 210 260' }));
}

const out = join(dirname(fileURLToPath(import.meta.url)), `${layout.map}.map`);
writeFileSync(out, entities.join('\n') + '\n');

const laneLen = u(layout.laneM);
const coverH = layout.boxes.filter((b) => b.h < WALL_H).map((b) => u(b.h));
console.log(`wrote ${out}`);
console.log(`  units/metre      ${U}`);
console.log(`  lane x           ${minX}..${maxX}  (interior width ${u(2 * layout.halfWidth)} u)`);
console.log(`  lane y           ${minY}..${maxY}`);
console.log(`  ceiling          ${ceilZ} u`);
console.log(`  spawn -> enemy   ${laneLen} u  (~${(laneLen / 250).toFixed(1)} s at 250 u/s)`);
console.log(`  eye height       ${u(EYE)} u`);
console.log(`  cover heights    ${coverH.join(', ')} u`);
console.log(`  brushes          ${brushes.length}, entities ${entities.length - 1}`);
