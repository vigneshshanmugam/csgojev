/**
 * The decision log for a comparison run: one JSON object per line.
 *
 *   {"t":"meta",...}                         who decided, with what body, against whom
 *   {"t":"round_start","round":3,...}
 *   {"t":"decision","round":3,"situation":{...},"choice":"enemy.peek","sent":true,"cached":false,...}
 *   {"t":"move","round":3,"from":"holding","to":"peeking","fired":false,...}
 *   {"t":"death","round":3,"who":"enemy"}
 *   {"t":"round_end","round":3,"result":"win",...}
 *
 * Decisions come from the runtime, so a repeat answered from its cache is
 * logged too, and `sent` says whether the chosen event reached the machine.
 * Moves are what the bot then did. The brain never sees cached repeats, so the
 * situation is recorded when the brain is asked and joined back by the
 * request's fingerprint.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JevClient, JevDecision } from '@xstate/jev';
import type { Move } from './bot';
import type { Inbound } from './protocol';

export interface RunLog {
  /** Wraps the brain so the situation behind every request is known. */
  client: (client: JevClient) => JevClient;
  /** Feeds round boundaries and outcomes from the plugin. `obs` is ignored. */
  packet: (packet: Inbound) => void;
  decision: (bot: number, decision: JevDecision) => void;
  move: (bot: number, move: Move) => void;
}

/** The runtime's request fingerprint (`requestKey` in @xstate/jev): FNV-1a over the JSON. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const REMEMBERED = 500;

export function openRunLog(path: string, meta: Record<string, unknown>): RunLog {
  mkdirSync(dirname(path), { recursive: true });
  const write = (line: Record<string, unknown>) => appendFileSync(path, `${JSON.stringify(line)}\n`);
  const situations = new Map<string, unknown>();
  let round = 0;
  write({ t: 'meta', at: Date.now(), ...meta });

  return {
    client: (client) => async (request) => {
      situations.set(fingerprint(request), request.state);
      while (situations.size > REMEMBERED) situations.delete(situations.keys().next().value!);
      try {
        return await client(request);
      } catch (error) {
        write({ t: 'error', round, at: Date.now(), error: String(error) });
        throw error;
      }
    },
    decision: (bot, d) => {
      if (d.reason === 'no-options') return;
      write({
        t: 'decision',
        round,
        bot,
        at: d.at,
        ms: d.latencyMs,
        situation: (d.key && situations.get(d.key)) ?? null,
        options: d.options.map((o) => o.id),
        choice: d.option?.id ?? null,
        reason: d.reason,
        probabilities: d.probabilities,
        confidence: d.confidence,
        cached: d.cached,
        sent: d.sent,
      });
    },
    move: (bot, m) => write({ t: 'move', round, bot, at: Date.now(), ...m }),
    packet: (packet) => {
      if (packet.t === 'round_start') write({ t: 'round_start', round: ++round, at: Date.now(), route: packet.route ?? null });
      else if (packet.t === 'bot_died') write({ t: 'death', round, who: 'bot', at: Date.now() });
      else if (packet.t === 'enemy_died') write({ t: 'death', round, who: 'enemy', at: Date.now() });
      else if (packet.t === 'round_end') write({ t: 'round_end', round, result: packet.result, at: Date.now() });
    },
  };
}
