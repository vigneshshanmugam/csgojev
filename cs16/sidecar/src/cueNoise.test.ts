import { describe, expect, it } from 'vitest';
import { applyCue, cueCondition, cueNoiseFromEnv } from './cueNoise';

describe('cue noise', () => {
  it('is off without a noise config', () => {
    expect(cueCondition(undefined, 7)).toBe('true');
    expect(cueNoiseFromEnv({})).toBeUndefined();
  });

  it('rolls the same condition for the same seed and round', () => {
    const noise = { miss: 0.3, flip: 0.3, seed: 5 };
    const a = Array.from({ length: 50 }, (_, i) => cueCondition(noise, i + 1));
    const b = Array.from({ length: 50 }, (_, i) => cueCondition(noise, i + 1));
    expect(a).toEqual(b);
    expect(a).not.toEqual(Array.from({ length: 50 }, (_, i) => cueCondition({ ...noise, seed: 6 }, i + 1)));
  });

  it('hits the configured rates', () => {
    const noise = { miss: 0.25, flip: 0.25, seed: 1 };
    const rolls = Array.from({ length: 4000 }, (_, i) => cueCondition(noise, i + 1));
    const share = (c: string) => rolls.filter((r) => r === c).length / rolls.length;
    expect(share('hidden')).toBeGreaterThan(0.22);
    expect(share('hidden')).toBeLessThan(0.28);
    expect(share('flipped')).toBeGreaterThan(0.22);
    expect(share('flipped')).toBeLessThan(0.28);
  });

  it('hides, flips or passes the label', () => {
    expect(applyCue('left', 'true')).toBe('left');
    expect(applyCue('left', 'flipped')).toBe('right');
    expect(applyCue('right', 'flipped')).toBe('left');
    expect(applyCue('left', 'hidden')).toBeNull();
    expect(applyCue(null, 'flipped')).toBeNull();
  });

  it('reads and validates the environment', () => {
    expect(cueNoiseFromEnv({ CUE_MISS: '0.2', CUE_FLIP: '0.1', CUE_SEED: '9' })).toEqual({ miss: 0.2, flip: 0.1, seed: 9 });
    expect(() => cueNoiseFromEnv({ CUE_MISS: '0.7', CUE_FLIP: '0.5' })).toThrow();
  });
});
