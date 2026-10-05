import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOOP_ID, type JevRequest } from '@xstate/jev';
import { RULES, randomClient, ruleChoice, ruleClient, rushChoice, type Situation } from './brains';
import { openRunLog } from './runLog';
import { createBot } from './bot';
import type { Inbound } from './protocol';

const base: Situation = {
  you: 'holding',
  playerInSight: false,
  aim: 'not on them',
  playerMoving: false,
  playerDistanceM: 22,
  footstepsHeard: false,
  secondsSincePlayerSeen: 'never seen this round',
  yourHp: 100,
  playerHp: 100,
  roundSecondsLeft: 45,
};
const at = (patch: Partial<Situation>): Situation => ({ ...base, ...patch });
const request = (state: Situation, options: string[]): JevRequest => ({
  state,
  questions: { action: { type: 'choice', instructions: '', criteria: Object.fromEntries(options.map((o) => [o, o])) } },
});

describe('rule brain', () => {
  const fromCover = ['enemy.peek', NOOP_ID];
  const exposed = ['enemy.shoot', 'enemy.fallBack', NOOP_ID];

  it('holds cover until a cue says the attacker is coming', () => {
    expect(ruleChoice(base, fromCover)).toBe(NOOP_ID);
    expect(ruleChoice(at({ footstepsHeard: true }), fromCover)).toBe('enemy.peek');
    expect(ruleChoice(at({ playerDistanceM: RULES.peekWithinM }), fromCover)).toBe('enemy.peek');
    expect(ruleChoice(at({ secondsSincePlayerSeen: RULES.peekAfterQuietS }), fromCover)).toBe('enemy.peek');
    expect(ruleChoice(at({ roundSecondsLeft: RULES.peekWhenRoundLeftS }), fromCover)).toBe('enemy.peek');
  });

  it('shoots only a settled aim, or a rushed one up close', () => {
    const scoped = at({ you: 'scoped', playerInSight: true });
    expect(ruleChoice({ ...scoped, aim: 'settled, your best shot' }, exposed)).toBe('enemy.shoot');
    expect(ruleChoice({ ...scoped, aim: 'half settled, a rushed shot', playerDistanceM: 20 }, exposed)).toBe(NOOP_ID);
    expect(ruleChoice({ ...scoped, aim: 'half settled, a rushed shot', playerDistanceM: 6 }, exposed)).toBe('enemy.shoot');
  });

  it('stops on sight while peeking and hides during the bolt', () => {
    expect(ruleChoice(at({ you: 'peeking', playerInSight: true }), ['enemy.counterStrafe', 'enemy.fallBack', NOOP_ID])).toBe('enemy.counterStrafe');
    expect(ruleChoice(at({ you: 'cycling' }), ['enemy.fallBack', NOOP_ID])).toBe('enemy.fallBack');
  });

  it('never picks a move the machine did not offer', () => {
    expect(ruleChoice(at({ you: 'scoped', playerInSight: true, aim: 'settled, your best shot' }), ['enemy.fallBack', NOOP_ID])).toBe(NOOP_ID);
  });

  it('answers in the shape Jev returns', async () => {
    const res = await ruleClient()(request(at({ footstepsHeard: true }), fromCover));
    expect(res.answers.action).toEqual({ type: 'choice', choice: 'enemy.peek', confidence: 1, probabilities: { 'enemy.peek': 1, noop: 0 } });
  });
});

describe('rush brain', () => {
  it('peeks at once and scopes at the peek spot, otherwise plays the rules', () => {
    expect(rushChoice(base, ['enemy.peek', NOOP_ID])).toBe('enemy.peek');
    expect(rushChoice(at({ you: 'peeking' }), ['enemy.counterStrafe', 'enemy.fallBack', NOOP_ID])).toBe('enemy.counterStrafe');
    expect(rushChoice(at({ you: 'scoped', playerInSight: true, aim: 'still settling, no shot yet' }), ['enemy.fallBack', NOOP_ID])).toBe(NOOP_ID);
    expect(rushChoice(at({ you: 'cycling' }), ['enemy.fallBack', NOOP_ID])).toBe('enemy.fallBack');
  });
});

describe('random brain', () => {
  it('picks uniformly among the offered moves only', async () => {
    const options = ['enemy.shoot', 'enemy.fallBack', NOOP_ID];
    const seen = new Set<string>();
    for (const r of [0, 0.4, 0.99]) {
      const res = await randomClient(() => r)(request(base, options));
      const answer = res.answers.action;
      if (answer.type !== 'choice') throw new Error('expected a choice');
      expect(options).toContain(answer.choice);
      seen.add(answer.choice);
    }
    expect(seen.size).toBe(3);
  });
});

describe('run log', () => {
  it('logs what the runtime decided, in which situation, and the move that followed', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'runlog-')), 'run.jsonl');
    const log = openRunLog(path, { brain: 'rule', difficulty: 2 });
    const bot = createBot({
      id: 1,
      client: log.client(ruleClient()),
      emit: () => {},
      onDecision: (d) => log.decision(1, d),
      onMove: (m) => log.move(1, m),
    });
    const feed = (packet: Inbound) => {
      log.packet(packet);
      bot.handle(packet);
    };
    const obs = { t: 'obs', bot: 1, hp: 100, visible: false, moving: false, dist: 20, enemyHp: 100, sinceSeen: -1, roundLeft: 60, weaponReady: true, atWaypoint: 'hold' } as const;
    const read = () => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

    feed({ t: 'round_start', bot: 1 });
    feed({ ...obs, footsteps: true });
    const until = Date.now() + 10_000;
    while (!read().some((l) => l.t === 'move') && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    feed({ t: 'enemy_died', bot: 1 });
    feed({ t: 'round_end', bot: 1, result: 'win' });
    bot.stop();

    const lines = read();
    const peek = lines.find((l) => l.t === 'decision' && l.choice === 'enemy.peek');
    expect(lines[0]).toMatchObject({ t: 'meta', brain: 'rule', difficulty: 2 });
    expect(peek).toMatchObject({ round: 1, sent: true, cached: false, situation: { you: 'holding', footstepsHeard: true } });
    expect(lines.filter((l) => l.t === 'decision').every((l) => l.situation)).toBe(true);
    expect(lines.find((l) => l.t === 'move')).toMatchObject({ round: 1, from: 'holding', to: 'peeking', fired: false });
    expect(lines.at(-1)).toMatchObject({ t: 'round_end', round: 1, result: 'win' });
  });
});
