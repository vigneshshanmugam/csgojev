import { afterEach, describe, expect, it } from 'vitest';
import { mockAnswers, type JevClient } from '@xstate/jev';
import { AIM_MIN_SECONDS, BOLT_SAFETY_MS, PEEK_SAFETY_MS, createBot } from './bot';
import type { Intent, Obs, Waypoint } from './protocol';

/** Mock Jev with its thumb on the scale, so a test reaches a state on purpose. */
const prefers = (...wanted: string[]): JevClient =>
  async (request) =>
    mockAnswers(request, ({ option }) => {
      const rank = wanted.findIndex((w) => option?.includes(w));
      // Everything else well below, so the bot commits instead of circling,
      // but waiting beats retreating: with an aim gate, a move it cannot make
      // yet is a move worth standing still for.
      return rank === -1 ? (option === 'noop' ? 0 : -4) : 8 - rank;
    });

const waitFor = async (predicate: () => boolean, ms = 15_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
};

/**
 * A plugin in miniature: perception at 20Hz, a bot whose legs take 200ms to
 * cross, a weapon busy for 300ms after a shot, and a scope that settles while
 * the bot is stopped and looking. Short on purpose — all three are well inside
 * the machine's safety nets, so anything the test sees happen quickly must
 * have come from the world and not from a timer.
 */
function drive(
  bot: ReturnType<typeof createBot>,
  intents: Intent[],
  opts: { visible?: boolean; aim?: boolean } = {},
) {
  const walkMs = 200;
  const weaponMs = 300;
  let waypoint: Waypoint | null = 'hold';
  let arriveAt = 0;
  let busyUntil = 0;
  let want: Waypoint = 'hold';
  let onTarget = 0;
  let last = Date.now();
  const consumed = new Set<number>();

  const timer = setInterval(() => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    const latest = intents[intents.length - 1];
    if (latest?.fire && !consumed.has(latest.seq)) {
      consumed.add(latest.seq);
      busyUntil = now + weaponMs;
    }
    const next: Waypoint = latest?.state === 'peeking' ? 'peek' : latest?.state === 'holding' ? 'hold' : want;
    if (next !== want) {
      want = next;
      waypoint = null;
      arriveAt = now + walkMs;
    }
    if (waypoint === null && now >= arriveAt) waypoint = want;

    // The scope only settles while the bot is stopped out in the lane.
    const visible = opts.visible ?? true;
    const settling = visible && (latest?.state === 'scoped' || latest?.state === 'cycling');
    onTarget = settling && opts.aim !== false ? onTarget + dt : 0;

    const obs: Obs = {
      t: 'obs', bot: bot.id, hp: 100, visible, moving: false, dist: 40,
      enemyHp: 100, footsteps: false, sinceSeen: 0.1, roundLeft: 80,
      weaponReady: now >= busyUntil, atWaypoint: waypoint, onTarget,
    };
    bot.handle(obs);
  }, 50);
  return () => clearInterval(timer);
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

function harness(client: JevClient, opts: { visible?: boolean; aim?: boolean } = {}) {
  const intents: Intent[] = [];
  const times: number[] = [];
  const bot = createBot({ id: 1, client, emit: (intent) => { intents.push(intent); times.push(Date.now()); } });
  bot.start();
  const stop = drive(bot, intents, opts);
  cleanup.push(() => { stop(); bot.stop(); });
  return { bot, intents, times, states: () => intents.map((i) => i.state) };
}

describe('bot', () => {
  it('emits an intent per state change, with a monotonic seq', async () => {
    const { intents, states } = harness(prefers('peek'));
    expect(await waitFor(() => states().includes('peeking'))).toBe(true);
    expect(intents[0]).toMatchObject({ t: 'intent', bot: 1, state: 'holding', fire: false, seq: 1 });
    expect(intents.map((i) => i.seq)).toEqual(intents.map((_, i) => i + 1));
  }, 30_000);

  it('leaves the swing when the world says the bot arrived, well inside the safety net', async () => {
    const { states } = harness(prefers('peek'));
    expect(await waitFor(() => states().includes('peeking'))).toBe(true);
    const at = Date.now();
    expect(await waitFor(() => states().includes('scoped'))).toBe(true);
    expect(Date.now() - at).toBeLessThan(PEEK_SAFETY_MS);
  }, 30_000);

  it('fires exactly once per shot and leaves cycling on the weapon, not the timer', async () => {
    const { intents, states } = harness(prefers('shoot', 'peek'));
    expect(await waitFor(() => states().includes('cycling'))).toBe(true);
    expect(intents.filter((i) => i.fire).length).toBe(1);
    const fired = intents.findIndex((i) => i.fire);
    expect(intents[fired].state).toBe('cycling');
    const at = Date.now();
    expect(await waitFor(() => states().indexOf('scoped', fired) > fired)).toBe(true);
    expect(Date.now() - at).toBeLessThan(BOLT_SAFETY_MS);
  }, 30_000);

  it('never sends a fire intent for a player the bot cannot see', async () => {
    const { intents, states } = harness(prefers('shoot', 'peek'), { visible: false });
    expect(await waitFor(() => states().includes('scoped'))).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(intents.some((i) => i.fire)).toBe(false);
    expect(states()).not.toContain('cycling');
  }, 30_000);

  it('never fires while the scope is still settling, however much Jev wants to', async () => {
    const { intents, states } = harness(prefers('shoot', 'peek'), { aim: false });
    expect(await waitFor(() => states().includes('scoped'))).toBe(true);
    await new Promise((r) => setTimeout(r, 1500)); // four times the settle, and still nothing
    expect(intents.some((i) => i.fire)).toBe(false);
    expect(states()).not.toContain('cycling');
  }, 30_000);

  it('waits out the settle before the first shot, rather than burning it on arrival', async () => {
    const { intents, times, states } = harness(prefers('shoot', 'peek'));
    expect(await waitFor(() => intents.some((i) => i.fire))).toBe(true);
    const stopped = times[states().indexOf('scoped')];
    const fired = times[intents.findIndex((i) => i.fire)];
    expect(fired - stopped).toBeGreaterThanOrEqual(AIM_MIN_SECONDS * 1000 - 60);
  }, 30_000);

  it('keeps deciding under a feed that repeats arrival and weapon-ready every frame', async () => {
    const intents: Intent[] = [];
    const bot = createBot({ id: 1, client: prefers('shoot', 'peek'), emit: (i) => intents.push(i) });
    bot.start();
    // The machine ignores these, but an ignored event still wakes the agent:
    // at 20Hz that resets its settle window and it never decides again.
    const timer = setInterval(() => bot.handle({
      t: 'obs', bot: 1, hp: 100, visible: true, moving: false, dist: 40, enemyHp: 100,
      footsteps: false, sinceSeen: 0.1, roundLeft: 80, weaponReady: true, atWaypoint: 'peek', onTarget: 5,
    }), 50);
    cleanup.push(() => { clearInterval(timer); bot.stop(); });
    expect(await waitFor(() => intents.some((i) => i.state === 'cycling'))).toBe(true);
  }, 30_000);

  it('takes death and round end from lifecycle packets', async () => {
    const { bot, states } = harness(prefers('peek'));
    bot.handle({ t: 'bot_died', bot: 1 });
    expect(await waitFor(() => states().includes('dead'), 1000)).toBe(true);
    bot.handle({ t: 'round_start', bot: 1 });
    expect(await waitFor(() => states().lastIndexOf('holding') > states().indexOf('dead'), 1000)).toBe(true);
  });
});
