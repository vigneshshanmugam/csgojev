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
import { BOXES, PLAYER_SPAWN, ENEMY_HOLD, ENEMY_PEEK, EYE, HALF_WIDTH, LANE_M, collide, type Box } from '../../src/game/map.js';

/** Units per metre. 1 GoldSrc unit ~= 1 inch. */
const U = 39.37;
const u = (m: number) => Math.round(m * U);

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
const WALL_H = Math.max(...BOXES.map((b) => b.h));
const PILLAR_H = Math.max(...BOXES.filter((b) => b.h < WALL_H).map((b) => b.h));

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
const minX = u(Math.min(...BOXES.map((b) => b.x0)));
const maxX = u(Math.max(...BOXES.map((b) => b.x1)));
const minY = u(Math.min(...BOXES.map((b) => b.z0)));
const maxY = u(Math.max(...BOXES.map((b) => b.z1)));
const ceilZ = u(Math.max(...BOXES.map((b) => b.h)));

const brushes: string[] = [
  box(minX, minY, -SHELL, maxX, maxY, 0, TEX.floor),
  box(minX, minY, ceilZ, maxX, maxY, ceilZ + SHELL, TEX.ceiling),
  ...BOXES.map((b) => {
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
const ctY = u(PLAYER_SPAWN.z);
const tY = u(ENEMY_HOLD.z);
const lim = u(HALF_WIDTH) - HULL;
const clampX = (x: number) => Math.max(-lim, Math.min(lim, x));
const ctXs = [0, 1, 2, 3].map((i) => clampX(u(PLAYER_SPAWN.x) - i * SPAWN_GAP));
// The two the duel is built around first, then fillers in the gap between them.
const tXs = [u(ENEMY_HOLD.x), u(ENEMY_PEEK.x), clampX(u(ENEMY_HOLD.x) + SPAWN_GAP), clampX(u(ENEMY_PEEK.x) + SPAWN_GAP)];

// A spawn inside a brush is a map that boots and then kills whoever joins.
for (const [x, y] of [...ctXs.map((x) => [x, ctY]), ...tXs.map((x) => [x, tY])]) {
  const m = collide(x / U, y / U, HULL / U);
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

const out = join(dirname(fileURLToPath(import.meta.url)), 'jev_duel.map');
writeFileSync(out, entities.join('\n') + '\n');

const laneLen = u(LANE_M);
const coverH = BOXES.filter((b) => b.h < WALL_H).map((b) => u(b.h));
console.log(`wrote ${out}`);
console.log(`  units/metre      ${U}`);
console.log(`  lane x           ${minX}..${maxX}  (interior width ${u(2 * HALF_WIDTH)} u)`);
console.log(`  lane y           ${minY}..${maxY}`);
console.log(`  ceiling          ${ceilZ} u`);
console.log(`  spawn -> enemy   ${laneLen} u  (~${(laneLen / 250).toFixed(1)} s at 250 u/s)`);
console.log(`  eye height       ${u(EYE)} u`);
console.log(`  cover heights    ${coverH.join(', ')} u`);
console.log(`  brushes          ${brushes.length}, entities ${entities.length - 1}`);
