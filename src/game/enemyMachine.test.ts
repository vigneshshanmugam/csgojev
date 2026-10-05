import { describe, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import { getOptions, mockAnswers } from '@xstate/jev';
import { BOLT_MS, EXPOSED_MS, PEEK_MS, createEnemyMachine } from './enemyMachine';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const machine = () => createEnemyMachine(async (r) => mockAnswers(r));
const seeing = { type: 'world.sync', playerVisible: true } as const;

describe('enemy machine', () => {
  it('legal flow: peek -> counterStrafe -> shoot -> cycling', () => {
    const a = createActor(machine());
    a.start();
    a.send({ type: 'enemy.shoot' } as never); // illegal while holding
    expect(a.getSnapshot().value).toBe('holding');
    a.send({ type: 'enemy.peek' });
    a.send(seeing);
    a.send({ type: 'enemy.counterStrafe' });
    expect(a.getSnapshot().value).toBe('scoped');
    a.send({ type: 'enemy.shoot' });
    expect(a.getSnapshot().value).toBe('cycling');
    expect(a.getSnapshot().context.shots).toBe(1);
    a.send({ type: 'world.playerDead' });
    expect(a.getSnapshot().value).toBe('victory');
    a.stop();
  });

  it('refuses to shoot at a player it cannot see, so Jev is told that is not a move', () => {
    const a = createActor(machine());
    a.start();
    a.send({ type: 'enemy.peek' });
    expect(a.getSnapshot().can({ type: 'enemy.shoot' })).toBe(false);
    a.send({ type: 'enemy.shoot' });
    expect(a.getSnapshot().value).toBe('peeking');
    expect(a.getSnapshot().context.shots).toBe(0);
    a.send(seeing);
    expect(a.getSnapshot().can({ type: 'enemy.shoot' })).toBe(true);
    a.stop();
  });

  it('owns its own timing: the swing settles, the bolt cycles, and it will not bake in the open', () => {
    vi.useFakeTimers();
    try {
      const a = createActor(machine());
      a.start();
      a.send({ type: 'enemy.peek' });
      expect(a.getSnapshot().value).toBe('peeking');
      vi.advanceTimersByTime(PEEK_MS + 10);
      expect(a.getSnapshot().value).toBe('scoped');

      a.send(seeing);
      a.send({ type: 'enemy.shoot' });
      expect(a.getSnapshot().value).toBe('cycling');
      vi.advanceTimersByTime(BOLT_MS - 50);
      expect(a.getSnapshot().value).toBe('cycling');
      vi.advanceTimersByTime(100);
      expect(a.getSnapshot().value).toBe('scoped');

      vi.advanceTimersByTime(EXPOSED_MS + 10);
      expect(a.getSnapshot().value).toBe('holding');
      a.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows Jev what a peek comes to, including the swing settling on its own', () => {
    const a = createActor(machine());
    a.start();
    const options = getOptions(a.getSnapshot(), {
      events: 'enemy.*',
      instructions: 'x',
      noop: 'wait',
      lookahead: true,
      state: (s: any) => ({ you: s.value }),
    });
    const peek = options.find((o) => o.id === 'enemy.peek');
    expect(peek?.lookahead).toContain('"holding" → "peeking"');
    expect(peek?.lookahead).toContain('Once done');
    a.stop();
  });

  it('jev agent drives the machine out of cover', async () => {
    const a = createActor(createEnemyMachine(async (r) => mockAnswers(r, ({ option }) => (option?.includes('peek') ? 5 : undefined))));
    // The bot peeks and falls back and peeks again, so what matters is that it
    // left cover at all, not where it happens to be at some instant.
    const visited = new Set<string>();
    a.subscribe((s) => visited.add(String(s.value)));
    a.start();
    for (let i = 0; i < 40 && !visited.has('peeking'); i++) await wait(50);
    expect([...visited]).toContain('peeking');
    a.stop();
  });
});
