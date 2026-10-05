import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cohenH, fisher, readRun, report, roundsNeeded, wilson } from './analyze';
import type { Situation } from './brains';

describe('statistics', () => {
  it('wilson matches the textbook interval', () => {
    const [lo, hi] = wilson(8, 10);
    expect(lo).toBeCloseTo(0.4902, 3);
    expect(hi).toBeCloseTo(0.9433, 3);
  });

  it('fisher matches the classic tea-tasting style tables', () => {
    expect(fisher(1, 9, 11, 3)).toBeCloseTo(0.002759, 5);
    expect(fisher(3, 1, 1, 3)).toBeCloseTo(0.4857, 3);
    expect(fisher(5, 5, 5, 5)).toBeCloseTo(1, 6);
  });

  it('sizes the experiment from the effect', () => {
    expect(cohenH(0.5, 0.5)).toBe(0);
    expect(roundsNeeded(0.5, 0.5)).toBe(Infinity);
    // Cohen's table: h = 0.2 needs 392 per group (two-sided 0.05, power 0.8).
    expect(roundsNeeded(Math.sin(Math.asin(Math.sqrt(0.5)) + 0.1) ** 2, 0.5)).toBe(393);
    expect(roundsNeeded(0.65, 0.5)).toBeGreaterThan(150);
    expect(roundsNeeded(0.9, 0.5)).toBeLessThan(25);
  });
});

describe('report', () => {
  const situation: Situation = {
    you: 'holding',
    playerInSight: false,
    aim: 'no target',
    playerMoving: false,
    playerDistanceM: null,
    footstepsHeard: true,
    secondsSincePlayerSeen: 'never seen this round',
    yourHp: 100,
    playerHp: 100,
    roundSecondsLeft: 60,
  } as unknown as Situation;

  it('scores only duel rounds, tables choices by situation, and follows each choice to its move', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jev-analyze-')), 'rule.jsonl');
    const decision = (round: number, at: number, cached = false) => ({
      t: 'decision', round, at, ms: 5, situation, options: ['enemy.peek', 'noop'], choice: 'enemy.peek', confidence: 1, cached, sent: true,
    });
    const lines = [
      { t: 'meta', brain: 'rule', weapon: 'weapon_awp', difficulty: 2 },
      { t: 'round_start', round: 1, at: 0 },
      decision(1, 100),
      { t: 'move', round: 1, at: 110, from: 'holding', to: 'peeking', fired: false },
      { t: 'round_end', round: 1, result: 'win', at: 9000 },
      { t: 'round_start', round: 2, at: 10_000 },
      decision(2, 10_100, true),
      { t: 'round_end', round: 2, result: 'loss', at: 20_000 },
      { t: 'round_start', round: 3, at: 30_000 }, // free play, never scored
      decision(3, 30_100),
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));

    const run = readRun(path);
    expect(run.rounds.map((r) => r.result)).toEqual(['win', 'loss']);
    expect(run.decisions).toHaveLength(2);
    const md = report([run]);
    expect(md).toContain('| rule | 2 | 1-1-0 | 50% |');
    expect(md).toContain('| rule | 2 | 50% | 100% | 100% | 0.0 | 0.5 |');
    expect(md).toContain('| rule | peek | 2 | holding→peeking 50%, no change 50% |');
    expect(md).toContain('**holding · footsteps**');
    expect(md).toContain('peek 100% (won 50%)');
  });
});
