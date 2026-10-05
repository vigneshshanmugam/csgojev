import { afterEach, describe, expect, it } from 'vitest';
import { mockAnswers, type JevClient } from '@xstate/jev';
import { openFakePlugin, type FakePlugin } from './fakePlugin';
import { startSidecar, type Sidecar } from './sidecar';

/**
 * Mock Jev, nudged out of cover: a bot that never peeks tests nothing. It also
 * has to rate waiting above retreating, or it falls back every time the aim
 * gate makes it stand still for a beat, and never takes a shot at all.
 */
const client: JevClient = async (request) =>
  mockAnswers(request, ({ option }) => {
    if (option?.includes('shoot')) return 9;
    if (option?.includes('peek')) return 4;
    if (option === 'noop') return 2;
    return undefined;
  });

let open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open) await close();
  open = [];
});

/** Both ends on ephemeral ports so tests never touch 27100/27101. */
async function duel(): Promise<{ plugin: FakePlugin; sidecar: Sidecar }> {
  const plugin = await openFakePlugin({ sidecarPort: 0, listenPort: 0, roundSeconds: 12 });
  const sidecar = await startSidecar({ client, inPort: 0, outPort: plugin.port });
  plugin.setSidecarPort(sidecar.port);
  open.push(() => plugin.close(), () => sidecar.close());
  return { plugin, sidecar };
}

describe('sidecar end to end over UDP', () => {
  it('plays a round against the fake plugin and reaches an outcome', async () => {
    const { plugin, sidecar } = await duel();
    const report = await plugin.round({ seed: 3 });

    expect(['win', 'loss', 'draw']).toContain(report.result);
    expect(report.intents).toBeGreaterThan(0);
    // It left cover under its own decisions and the engine's legs carried it there.
    expect(report.states).toContain('peeking');
    expect(report.states).toContain('scoped');
    expect(report.arrivals).toBeGreaterThan(0);
    // Every shot came from a one-shot fire intent, and the machine only allows
    // one per `cycling`, so the plugin never saw a duplicate.
    expect(report.shots).toBeLessThanOrEqual(report.states.filter((s) => s === 'cycling').length);
    // No hopeless shots: the aim gate means the worst shot on the menu is a
    // rushed one, not the ~0.06 the bot used to burn its opener on.
    expect(report.chances.length).toBeGreaterThan(0);
    for (const chance of report.chances) expect(chance).toBeGreaterThan(0.3);
    expect(sidecar.bots.get(1)?.stats().decisions).toBeGreaterThan(0);
  }, 30_000);

  it('ends the round on the lifecycle event the plugin sends', async () => {
    const { plugin } = await duel();
    const report = await plugin.round({ behaviour: 'holder', roundSeconds: 6, seed: 7 });
    // The holder never clears the pillar, so nobody can win: the round times out.
    expect(report.result).toBe('draw');
    expect(report.states[report.states.length - 1]).toBe('timeout');
  }, 30_000);
});
