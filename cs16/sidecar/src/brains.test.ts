import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOOP_ID, type JevRequest } from '@xstate/jev';
import { RULES, SWEEP_SIDE_SECONDS, createSweepChoice, cueChoice, cueHoldChoice, createCueSwitchChoice, createCueCheckChoice, fixedSideChoice, randomClient, ruleChoice, ruleClient, rushChoice, rushHoldChoice, type Situation } from './brains';
import { openRunLog } from './runLog';
import { MEMORY_ROUNDS, createBot, roundSummary } from './bot';
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

describe('rush-hold brain', () => {
  it('differs from rush only by never falling back while scoped', () => {
    const hurt = at({ you: 'scoped', playerInSight: true, aim: 'still settling, no shot yet', yourHp: 20 });
    const offered = ['enemy.fallBack', NOOP_ID];
    expect(rushChoice(hurt, offered)).toBe('enemy.fallBack');
    expect(rushHoldChoice(hurt, offered)).toBe(NOOP_ID);
    expect(rushHoldChoice({ ...hurt, aim: 'settled, your best shot' }, ['enemy.shoot', ...offered])).toBe('enemy.shoot');
    expect(rushHoldChoice(at({ you: 'cycling' }), offered)).toBe('enemy.fallBack');
    expect(rushHoldChoice(base, ['enemy.peek', NOOP_ID])).toBe('enemy.peek');
  });
});

describe('split-lane brains', () => {
  const splitCover = ['enemy.peekLeft', 'enemy.peekRight', NOOP_ID];

  it('left and right are fixed-side openers', () => {
    expect(fixedSideChoice('left', base, splitCover)).toBe('enemy.peekLeft');
    expect(fixedSideChoice('right', base, splitCover)).toBe('enemy.peekRight');
    expect(fixedSideChoice('left', at({ you: 'peekingLeft', playerInSight: true }), ['enemy.counterStrafe', NOOP_ID]))
      .toBe('enemy.counterStrafe');
  });

  it('cue waits for a side cue, then peeks that side', () => {
    expect(cueChoice(base, splitCover)).toBe(NOOP_ID);
    expect(cueChoice(at({ footstepsFrom: 'left' }), splitCover)).toBe('enemy.peekLeft');
    expect(cueChoice(at({ playerLastSeenOn: 'right' }), splitCover)).toBe('enemy.peekRight');
  });

  it('cuehold is cue without the scoped retreat', () => {
    const hurt = at({ you: 'scoped', playerInSight: true, yourHp: 30, aim: 'still settling, no shot yet' });
    const offered = ['enemy.fallBack', NOOP_ID];
    expect(cueChoice(hurt, offered)).toBe('enemy.fallBack');
    expect(cueHoldChoice(hurt, offered)).toBe(NOOP_ID);
    expect(cueHoldChoice(at({ footstepsFrom: 'left' }), splitCover)).toBe('enemy.peekLeft');
  });

  it('cueswitch peeks the cue, drops a dry lane after a while, then tries the other', () => {
    let t = 0;
    const choose = createCueSwitchChoice(() => t, () => 0);
    expect(choose(at({ footstepsFrom: 'left' }), splitCover)).toBe('enemy.peekLeft');
    const dry = at({ you: 'scoped', side: 'left', footstepsFrom: 'left' });
    expect(choose(dry, ['enemy.fallBack', NOOP_ID])).toBe(NOOP_ID);
    t = SWEEP_SIDE_SECONDS;
    expect(choose(dry, ['enemy.fallBack', NOOP_ID])).toBe('enemy.fallBack');
    // the cue still says left, but that lane was dry
    expect(choose(at({ footstepsFrom: 'left' }), splitCover)).toBe('enemy.peekRight');
  });

  it('cueswitch waits as long as its own timer says', () => {
    let t = 0;
    const choose = createCueSwitchChoice(() => t, () => 0, 7);
    choose(at({ footstepsFrom: 'left' }), splitCover);
    const dry = at({ you: 'scoped', side: 'left', footstepsFrom: 'left' });
    t = SWEEP_SIDE_SECONDS + 1;
    expect(choose(dry, ['enemy.fallBack', NOOP_ID])).toBe(NOOP_ID);
    t = 7;
    expect(choose(dry, ['enemy.fallBack', NOOP_ID])).toBe('enemy.fallBack');
  });

  it('cuecheck marks a lane dry when a peek ends unseen, even by the machine reflex', () => {
    const choose = createCueCheckChoice(() => 0);
    expect(choose(at({ footstepsFrom: 'left' }), splitCover)).toBe('enemy.peekLeft');
    choose(at({ you: 'scoped', side: 'left', footstepsFrom: 'left' }), ['enemy.fallBack', NOOP_ID]);
    // the reflex put it back in cover; the label still says left
    expect(choose(at({ footstepsFrom: 'left' }), splitCover)).toBe('enemy.peekRight');
  });

  it('cuecheck keeps a lane it saw the player on, and trusts a sighting over the label', () => {
    const choose = createCueCheckChoice(() => 0);
    choose(at({ footstepsFrom: 'left' }), splitCover);
    choose(at({ you: 'scoped', side: 'left', playerInSight: true }), ['enemy.fallBack', NOOP_ID]);
    expect(choose(at({ footstepsFrom: 'left' }), splitCover)).toBe('enemy.peekLeft');
    const fresh = createCueCheckChoice(() => 0);
    expect(fresh(at({ footstepsFrom: 'left', playerLastSeenOn: 'right' }), splitCover)).toBe('enemy.peekRight');
  });

  it('cueswitch stays on a lane once it sees the player', () => {
    let t = 0;
    const choose = createCueSwitchChoice(() => t, () => 0);
    choose(at({ footstepsFrom: 'left' }), splitCover);
    const seen = at({ you: 'scoped', side: 'left', playerInSight: true });
    choose(seen, ['enemy.fallBack', NOOP_ID]);
    t = SWEEP_SIDE_SECONDS + 1;
    expect(choose(seen, ['enemy.fallBack', NOOP_ID])).not.toBe('enemy.fallBack');
  });

  it('cue guesses on quiet or low clock only when no side cue exists', () => {
    const left = () => 0.1;
    const right = () => 0.9;
    expect(cueChoice(at({ secondsSincePlayerSeen: RULES.peekAfterQuietS }), splitCover, left)).toBe('enemy.peekLeft');
    expect(cueChoice(at({ roundSecondsLeft: RULES.peekWhenRoundLeftS }), splitCover, right)).toBe('enemy.peekRight');
    expect(cueChoice(at({ footstepsFrom: 'left', roundSecondsLeft: RULES.peekWhenRoundLeftS }), splitCover, right)).toBe('enemy.peekLeft');
  });

  it('sweep opens left without reading split cues', () => {
    const choose = createSweepChoice(() => 0);
    expect(choose(at({ footstepsFrom: 'right', playerLastSeenOn: 'right' }), splitCover)).toBe('enemy.peekLeft');
  });

  it('sweep falls back after a dry side, then checks the other side', () => {
    let t = 0;
    const choose = createSweepChoice(() => t);
    expect(choose(base, splitCover)).toBe('enemy.peekLeft');

    t = SWEEP_SIDE_SECONDS - 0.1;
    expect(choose(at({ you: 'scoped', side: 'left', roundSecondsLeft: 40 }), ['enemy.fallBack', NOOP_ID])).toBe(NOOP_ID);

    t = SWEEP_SIDE_SECONDS;
    expect(choose(at({ you: 'scoped', side: 'left', roundSecondsLeft: 40 }), ['enemy.fallBack', NOOP_ID])).toBe('enemy.fallBack');
    expect(choose(at({ roundSecondsLeft: 40 }), splitCover)).toBe('enemy.peekRight');
  });

  it('sweep uses normal combat rules after seeing the player', () => {
    let t = 0;
    const choose = createSweepChoice(() => t);
    expect(choose(base, splitCover)).toBe('enemy.peekLeft');
    expect(choose(at({ you: 'peekingLeft', side: 'left', playerInSight: true, roundSecondsLeft: 40 }), ['enemy.counterStrafe', NOOP_ID]))
      .toBe('enemy.counterStrafe');

    t = SWEEP_SIDE_SECONDS + 5;
    expect(choose(at({ you: 'scoped', side: 'left', playerInSight: false, roundSecondsLeft: 40 }), ['enemy.fallBack', NOOP_ID]))
      .toBe(NOOP_ID);
  });

  it('sweep resets to left when a new round starts', () => {
    let t = 0;
    const choose = createSweepChoice(() => t);
    expect(choose(base, splitCover)).toBe('enemy.peekLeft');
    t = SWEEP_SIDE_SECONDS;
    expect(choose(at({ you: 'scoped', side: 'left', roundSecondsLeft: 40 }), ['enemy.fallBack', NOOP_ID])).toBe('enemy.fallBack');
    expect(choose(at({ roundSecondsLeft: 40 }), splitCover)).toBe('enemy.peekRight');
    expect(choose(base, splitCover)).toBe('enemy.peekLeft');
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

describe('memory', () => {
  it('summarises how a round opened and ended', () => {
    expect(roundSummary(0.4, 'win', null)).toBe('peeked at once; won');
    expect(roundSummary(7.6, 'loss', 'scoped')).toBe('waited 8s, then peeked; lost, killed while scoped');
    expect(roundSummary(null, 'draw', null)).toBe('never peeked; draw, the timer ran out');
  });

  it('shows the brain earlier rounds, newest last, capped, and only when asked', async () => {
    const seen: unknown[] = [];
    const client: typeof ruleClient extends () => infer C ? C : never = async (request) => {
      seen.push((request.state as { earlierRounds?: unknown }).earlierRounds);
      return ruleClient()(request);
    };
    const obs = { t: 'obs', bot: 1, hp: 100, visible: false, moving: false, dist: 20, enemyHp: 100, footsteps: true, sinceSeen: -1, roundLeft: 60, weaponReady: true, atWaypoint: 'hold' } as const;
    const settle = () => new Promise((r) => setTimeout(r, 400));

    const bot = createBot({ id: 1, client, emit: () => {}, memory: true });
    for (let i = 0; i < MEMORY_ROUNDS + 1; i++) {
      bot.handle({ t: 'round_start', bot: 1 });
      bot.handle(obs);
      await settle();
      bot.handle({ t: 'bot_died', bot: 1 });
      bot.handle({ t: 'round_end', bot: 1, result: 'loss' });
    }
    bot.stop();
    expect(seen[0]).toBe('none yet');
    expect(bot.history()).toHaveLength(MEMORY_ROUNDS);
    expect(bot.history().at(-1)).toMatch(/^peeked at once; lost, killed while (peeking|scoped)$/);
    expect(seen.at(-1)).toHaveLength(MEMORY_ROUNDS);

    const plain: unknown[] = [];
    const control = createBot({ id: 2, client: async (r) => (plain.push(r.state), ruleClient()(r)), emit: () => {} });
    control.handle({ t: 'round_start', bot: 2 });
    control.handle({ ...obs, bot: 2 });
    await settle();
    control.stop();
    expect(plain[0]).not.toHaveProperty('earlierRounds');
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
