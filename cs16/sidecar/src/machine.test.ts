import { describe, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import { mockAnswers } from '@xstate/jev';
import { BOLT_MS, PEEK_MS, createEnemyMachine } from '../../../src/game/enemyMachine';
import { AIM_MIN_SECONDS, AIM_SETTLED_SECONDS, BOLT_SAFETY_MS, PEEK_SAFETY_MS } from './bot';

const sidecarMachine = () =>
  createEnemyMachine(async (r) => mockAnswers(r), {
    peekMs: PEEK_SAFETY_MS,
    boltMs: BOLT_SAFETY_MS,
    aimSeconds: AIM_MIN_SECONDS,
    aimSettledSeconds: AIM_SETTLED_SECONDS,
  });
/** Seen, and the scope settled: both are needed before a shot is a shot. */
const seeing = { type: 'world.sync', playerVisible: true, onTarget: AIM_SETTLED_SECONDS } as const;

describe('machine against a real engine', () => {
  it('ends the swing when the bot physically arrives, not on a timer', () => {
    vi.useFakeTimers();
    try {
      const a = createActor(sidecarMachine());
      a.start();
      a.send({ type: 'enemy.peek' });
      vi.advanceTimersByTime(PEEK_MS + 50); // the prototype's simulated swing: not the truth here
      expect(a.getSnapshot().value).toBe('peeking');
      a.send({ type: 'world.arrived' });
      expect(a.getSnapshot().value).toBe('scoped');
      a.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the swing timer as a safety net for a plugin that never reports arrival', () => {
    vi.useFakeTimers();
    try {
      const a = createActor(sidecarMachine());
      a.start();
      a.send({ type: 'enemy.peek' });
      vi.advanceTimersByTime(PEEK_SAFETY_MS + 50);
      expect(a.getSnapshot().value).toBe('scoped');
      a.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the bolt cycle on the real weapon, with the timer as the net', () => {
    vi.useFakeTimers();
    try {
      const a = createActor(sidecarMachine());
      a.start();
      a.send({ type: 'enemy.peek' });
      a.send(seeing);
      a.send({ type: 'world.arrived' });
      a.send({ type: 'enemy.shoot' });
      expect(a.getSnapshot().value).toBe('cycling');
      vi.advanceTimersByTime(BOLT_MS + 50);
      expect(a.getSnapshot().value).toBe('cycling');
      a.send({ type: 'world.weaponReady' });
      expect(a.getSnapshot().value).toBe('scoped');

      a.send({ type: 'enemy.shoot' });
      vi.advanceTimersByTime(BOLT_SAFETY_MS + 50);
      expect(a.getSnapshot().value).toBe('scoped');
      a.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reflexes out of the open on EXPOSED_MS: that one is behaviour, not physics', () => {
    vi.useFakeTimers();
    try {
      const a = createActor(sidecarMachine());
      a.start();
      a.send({ type: 'enemy.peek' });
      a.send({ type: 'world.arrived' });
      expect(a.getSnapshot().value).toBe('scoped');
      vi.advanceTimersByTime(5000 + 50);
      expect(a.getSnapshot().value).toBe('holding');
      a.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a shot whose aim has not settled, so it is never on the menu', () => {
    const a = createActor(sidecarMachine());
    a.start();
    a.send({ type: 'enemy.peek' });
    a.send({ type: 'world.arrived' });
    // Stopped and looking right at them, but the scope has not caught up yet.
    a.send({ type: 'world.sync', playerVisible: true, onTarget: AIM_MIN_SECONDS - 0.01 });
    expect(a.getSnapshot().can({ type: 'enemy.shoot' })).toBe(false);
    a.send({ type: 'enemy.shoot' });
    expect(a.getSnapshot().value).toBe('scoped');
    expect(a.getSnapshot().context.shots).toBe(0);

    a.send({ type: 'world.sync', onTarget: AIM_MIN_SECONDS });
    expect(a.getSnapshot().can({ type: 'enemy.shoot' })).toBe(true);
    a.send({ type: 'enemy.shoot' });
    expect(a.getSnapshot().value).toBe('cycling');
    a.stop();
  });

  it('still refuses to shoot what it cannot see, settled aim or not', () => {
    const a = createActor(sidecarMachine());
    a.start();
    a.send({ type: 'enemy.peek' });
    a.send({ type: 'world.sync', playerVisible: false, onTarget: 10 });
    expect(a.getSnapshot().can({ type: 'enemy.shoot' })).toBe(false);
    a.stop();
  });

  it('leaves the prototype alone: with no aim reported there is no aim gate', () => {
    const a = createActor(createEnemyMachine(async (r) => mockAnswers(r)));
    a.start();
    a.send({ type: 'enemy.peek' });
    a.send({ type: 'world.sync', playerVisible: true }); // onTarget stays 0, as the renderer leaves it
    expect(a.getSnapshot().can({ type: 'enemy.shoot' })).toBe(true);
    a.stop();
  });

  it('shows Jev the aim, so waiting for a shot reads differently from waiting for nothing', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const spy = async (request: Parameters<typeof mockAnswers>[0]) => {
      seen.push(request.state as Record<string, unknown>);
      return mockAnswers(request);
    };
    const gated = createActor(createEnemyMachine(spy, { aimSeconds: AIM_MIN_SECONDS, aimSettledSeconds: AIM_SETTLED_SECONDS }));
    gated.start();
    gated.send({ type: 'enemy.peek' });
    gated.send({ type: 'world.arrived' });
    gated.send({ type: 'world.sync', playerVisible: true, onTarget: AIM_MIN_SECONDS / 2 });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(seen[seen.length - 1].aim).toBe('still settling, no shot yet');
    gated.stop();

    // The prototype measures no aim, so it is not told about one.
    const plain: Array<Record<string, unknown>> = [];
    const ungated = createActor(createEnemyMachine(async (request) => {
      plain.push(request.state as Record<string, unknown>);
      return mockAnswers(request);
    }));
    ungated.start();
    await vi.waitFor(() => expect(plain.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(plain[plain.length - 1]).not.toHaveProperty('aim');
    ungated.stop();
  }, 20_000);

  it('takes death and round end from lifecycle events', () => {
    for (const [event, expected] of [
      ['world.enemyDead', 'dead'],
      ['world.playerDead', 'victory'],
      ['world.roundOver', 'timeout'],
    ] as const) {
      const a = createActor(sidecarMachine());
      a.start();
      a.send({ type: event });
      expect(a.getSnapshot().value).toBe(expected);
      a.stop();
    }
  });
});
