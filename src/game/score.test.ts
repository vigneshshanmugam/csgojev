import { describe, expect, it } from 'vitest';
import { applyOutcome, loadScore, matchResult, saveScore } from './score';

describe('score', () => {
  const zero = { human: 0, jev: 0, draws: 0, streak: 0 };
  it('tallies outcomes and streak', () => {
    let s = applyOutcome(zero, 'win');
    s = applyOutcome(s, 'win');
    expect(s).toEqual({ human: 2, jev: 0, draws: 0, streak: 2 });
    s = applyOutcome(s, 'lose');
    expect(s).toEqual({ human: 2, jev: 1, draws: 0, streak: 0 });
    expect(applyOutcome(s, 'time').draws).toBe(1);
  });
  it('round-trips storage and survives garbage', () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveScore({ human: 1, jev: 2, draws: 3, streak: 0 }, st);
    expect(loadScore(st).jev).toBe(2);
    m.set('csgojev.score', '{bad');
    expect(loadScore(st)).toEqual(zero);
  });
  it('decides best of 20', () => {
    expect(matchResult({ human: 10, jev: 9, draws: 0, streak: 0 })).toBeNull();
    expect(matchResult({ human: 11, jev: 2, draws: 0, streak: 3 })).toBe('human');
    expect(matchResult({ human: 3, jev: 11, draws: 0, streak: 0 })).toBe('jev');
    expect(matchResult({ human: 8, jev: 8, draws: 4, streak: 0 })).toBe('tie');
    expect(matchResult({ human: 9, jev: 8, draws: 3, streak: 0 })).toBe('human');
  });
});
