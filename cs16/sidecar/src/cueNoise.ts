/**
 * Makes the split-lane side cue unreliable, for every brain alike. Applied in
 * the sidecar so the plugin and the map stay as they were: per round, the
 * `footstepsFrom` label is either true, hidden, or points at the wrong lane.
 * Sightings (`lastSeenSide`) stay true, so a brain that cross-checks has
 * something to correct a bad label with.
 *
 * The roll depends only on seed and round number, so a run log can recompute
 * it and every brain sees the same corruption for the same round index.
 */
export type CueCondition = 'true' | 'hidden' | 'flipped';

export interface CueNoise {
  /** Chance a round's label is hidden (`none` all round). */
  miss: number;
  /** Chance a round's label points at the opposite lane. */
  flip: number;
  seed: number;
}

/** mulberry32: small, seedable, good enough for a coin per round. */
function rand(seed: number): number {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function cueCondition(noise: CueNoise | undefined, round: number): CueCondition {
  if (!noise) return 'true';
  const r = rand(noise.seed * 100_003 + round);
  if (r < noise.miss) return 'hidden';
  if (r < noise.miss + noise.flip) return 'flipped';
  return 'true';
}

export function applyCue(
  from: 'left' | 'right' | null | undefined,
  condition: CueCondition,
): 'left' | 'right' | null {
  if (!from || condition === 'hidden') return null;
  if (condition === 'flipped') return from === 'left' ? 'right' : 'left';
  return from;
}

/**
 * `CUE_MISS`, `CUE_FLIP`, `CUE_SEED` from the environment; off unless one is set.
 * The slot is folded into the seed: every block restarts its round count, so a
 * seed alone replays the same few rolls. Keyed on slot, both arms on a slot see
 * the same rolls and the slots see different ones.
 */
export function cueNoiseFromEnv(env: Record<string, string | undefined> = process.env): CueNoise | undefined {
  const miss = Number(env.CUE_MISS ?? 0);
  const flip = Number(env.CUE_FLIP ?? 0);
  if (!(miss > 0 || flip > 0)) return undefined;
  if (miss < 0 || flip < 0 || miss + flip > 1) throw new Error('CUE_MISS and CUE_FLIP must be >= 0 and sum to at most 1');
  return { miss, flip, seed: Number(env.CUE_SEED ?? 1) * 1009 + Number(env.SLOT ?? 0) };
}
