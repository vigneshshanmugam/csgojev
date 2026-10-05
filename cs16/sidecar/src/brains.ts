/**
 * Baseline brains for the Jev comparison. Each is a `JevClient`: it receives
 * the request Jev would receive (what the bot sees, and the legal moves the
 * machine offers right now) and answers in Jev's shape. The body, the machine
 * and the opponent stay identical; only the decision-maker changes.
 *
 *   random  picks uniformly among the offered moves (including waiting)
 *   rule    a hand-written AWPer: fixed if/then rules over the same cues
 *   rush    the aggressive AWPer: peek at once, scope up at the peek spot,
 *           otherwise the rule brain. Tests whether Jev beats "be aggressive".
 */
import { NOOP_ID, type JevAnswer, type JevClient, type JevRequest } from '@xstate/jev';

export const brains = ['jev', 'rule', 'rush', 'random', 'mock'] as const;
export type BrainName = (typeof brains)[number];

/** What `createEnemyMachine` shows the brain. Mirrors its `state` callback. */
export interface Situation {
  you: 'holding' | 'peeking' | 'scoped' | 'cycling' | string;
  playerInSight: boolean;
  aim?: 'not on them' | 'still settling, no shot yet' | 'half settled, a rushed shot' | 'settled, your best shot';
  playerMoving: boolean;
  playerDistanceM: number;
  footstepsHeard: boolean;
  secondsSincePlayerSeen: number | 'never seen this round';
  yourHp: number;
  playerHp: number;
  roundSecondsLeft: number;
}

const PEEK = 'enemy.peek';
const STRAFE = 'enemy.counterStrafe';
const SHOOT = 'enemy.shoot';
const FALL_BACK = 'enemy.fallBack';

/** The thresholds the rule brain acts on, in one place so a report can quote them. */
export const RULES = {
  /** Peek from cover once the attacker is this close (metres). */
  peekWithinM: 14,
  /** Or once it has been quiet this long (seconds since last seen). */
  peekAfterQuietS: 6,
  /** Or when the round is this close to running out (seconds). */
  peekWhenRoundLeftS: 20,
  /** Take a half-settled shot only when the attacker is this close (metres). */
  rushedShotWithinM: 8,
  /** Below this HP, retreat rather than wait for aim to settle. */
  retreatBelowHp: 50,
} as const;

/** The rule brain's choice for one situation, from the options the machine offers. */
export function ruleChoice(s: Situation, offered: readonly string[]): string {
  const has = (id: string) => offered.includes(id);
  const wait = has(NOOP_ID) ? NOOP_ID : offered[0];
  const quiet = typeof s.secondsSincePlayerSeen === 'number' ? s.secondsSincePlayerSeen : 0;

  if (has(SHOOT)) {
    if (s.aim === 'settled, your best shot') return SHOOT;
    if (s.aim === 'half settled, a rushed shot' && s.playerDistanceM <= RULES.rushedShotWithinM) return SHOOT;
  }
  if (s.you === 'cycling') return has(FALL_BACK) ? FALL_BACK : wait;
  if (s.you === 'peeking') return s.playerInSight && has(STRAFE) ? STRAFE : wait;
  if (s.you === 'scoped') {
    if (s.playerInSight && s.yourHp < RULES.retreatBelowHp && has(FALL_BACK)) return FALL_BACK;
    return wait;
  }
  if (s.you === 'holding' && has(PEEK)) {
    if (s.footstepsHeard) return PEEK;
    if (s.playerDistanceM <= RULES.peekWithinM) return PEEK;
    if (quiet >= RULES.peekAfterQuietS) return PEEK;
    if (s.roundSecondsLeft <= RULES.peekWhenRoundLeftS) return PEEK;
  }
  return wait;
}

/** The rush brain: no waiting in cover, and the scope goes up before the attacker shows. */
export function rushChoice(s: Situation, offered: readonly string[]): string {
  if (s.you === 'holding' && offered.includes(PEEK)) return PEEK;
  if (s.you === 'peeking' && offered.includes(STRAFE)) return STRAFE;
  return ruleChoice(s, offered);
}

/** Answers every choice question with `pick`, in exactly the shape Jev returns. */
function answerWith(request: JevRequest, pick: (offered: string[]) => { choice: string; probabilities: Record<string, number> }) {
  const answers: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    if (q.type !== 'choice') continue;
    const offered = Object.keys(q.criteria);
    const { choice, probabilities } = pick(offered);
    answers[id] = { type: 'choice', choice, probabilities, confidence: 1 };
  }
  return { answers, mock: true };
}

export const ruleClient = (choose = ruleChoice): JevClient => async (request) =>
  answerWith(request, (offered) => {
    const choice = choose(request.state as Situation, offered);
    return { choice, probabilities: Object.fromEntries(offered.map((o) => [o, o === choice ? 1 : 0])) };
  });

export const randomClient = (rand: () => number = Math.random): JevClient => async (request) =>
  answerWith(request, (offered) => ({
    choice: offered[Math.floor(rand() * offered.length)],
    probabilities: Object.fromEntries(offered.map((o) => [o, Number((1 / offered.length).toFixed(4))])),
  }));
