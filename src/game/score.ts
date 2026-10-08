export type Outcome = 'win' | 'lose' | 'time';
export interface Score { human: number; jev: number; draws: number; streak: number }

const KEY = 'csgojev.score';
const EMPTY: Score = { human: 0, jev: 0, draws: 0, streak: 0 };

export function loadScore(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Score {
  try {
    const raw = storage?.getItem(KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : { ...EMPTY };
  } catch { return { ...EMPTY }; }
}

export function applyOutcome(s: Score, o: Outcome): Score {
  if (o === 'win') return { ...s, human: s.human + 1, streak: s.streak + 1 };
  if (o === 'lose') return { ...s, jev: s.jev + 1, streak: 0 };
  return { ...s, draws: s.draws + 1, streak: 0 };
}

export function saveScore(s: Score, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export const MATCH_ROUNDS = 20;
const CLINCH = MATCH_ROUNDS / 2 + 1;

export const EMPTY_SCORE: Score = EMPTY;
export const roundsPlayed = (s: Score) => s.human + s.jev + s.draws;

/** Best of 20: ends when a side clinches 11, or all 20 rounds are played. */
export function matchResult(s: Score): null | 'human' | 'jev' | 'tie' {
  if (s.human >= CLINCH) return 'human';
  if (s.jev >= CLINCH) return 'jev';
  if (roundsPlayed(s) >= MATCH_ROUNDS) return s.human > s.jev ? 'human' : s.jev > s.human ? 'jev' : 'tie';
  return null;
}
