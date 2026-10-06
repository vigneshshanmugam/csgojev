/**
 * The sidecar is a server, so it holds the TypeSafe key itself instead of
 * proxying through Vite like the browser does. Key never leaves this file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mockAnswers, type JevClient } from '@xstate/jev';
import { cueChoice, cueHoldChoice, fixedSideChoice, randomClient, ruleClient, rushChoice, rushHoldChoice, sweepClient, type BrainName } from './brains';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Minimal `.env` reader: the repo keeps the key there and it is gitignored. */
function envKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')) {
      const match = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[1].trim().replace(/^['"]|['"]$/g, '');
      if (value) return value;
    }
  } catch {
    // No .env is the normal offline case.
  }
  return undefined;
}

export interface ClientHandle {
  client: JevClient;
  live: boolean;
}

/**
 * The decision-maker. `jev` (and `jevmem`, the same Jev shown its recent
 * rounds) is real Jev when a key is present and the mock otherwise, so the
 * sidecar always runs; `rule`, `rush` and `random` are the baselines it is
 * compared against (see brains.ts).
 */
export async function makeClient(brain: BrainName = 'jev'): Promise<ClientHandle> {
  if (brain === 'rule') return { client: ruleClient(), live: false };
  if (brain === 'rush') return { client: ruleClient(rushChoice), live: false };
  if (brain === 'rushhold') return { client: ruleClient(rushHoldChoice), live: false };
  if (brain === 'left') return { client: ruleClient((s, offered) => fixedSideChoice('left', s, offered)), live: false };
  if (brain === 'right') return { client: ruleClient((s, offered) => fixedSideChoice('right', s, offered)), live: false };
  if (brain === 'cue') return { client: ruleClient(cueChoice), live: false };
  if (brain === 'cuehold') return { client: ruleClient(cueHoldChoice), live: false };
  if (brain === 'sweep') return { client: sweepClient(), live: false };
  if (brain === 'random') return { client: randomClient(), live: false };
  const key = brain === 'mock' ? undefined : envKey();
  if (!key) return { client: async (request) => mockAnswers(request), live: false };
  const { TypeSafeClient } = await import('@typesafe-ai/sdk');
  const ts = new TypeSafeClient({ apiKey: key, timeout: 30_000 });
  return {
    live: true,
    client: async (request) => ({
      answers: (await ts.systemOne({ state: request.state as never, questions: request.questions as never }))
        .answers as never,
    }),
  };
}
