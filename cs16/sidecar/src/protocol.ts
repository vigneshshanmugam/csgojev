/**
 * The plugin ↔ sidecar wire. Newline-delimited JSON over UDP on localhost.
 * Fixed: the Metamod plugin is written against this and the two halves never
 * share code, so nothing here may change without changing both.
 */
import { z } from 'zod';

export const HOST = '127.0.0.1';
/** Plugin → sidecar: perception at ~20Hz. */
export const OBS_PORT = 27100;
/** Sidecar → plugin: intent on every state change plus a 1Hz heartbeat. */
export const INTENT_PORT = 27101;

/** The machine's state values, as the plugin sees them. */
export const machineStates = ['holding', 'peeking', 'scoped', 'cycling', 'dead', 'victory', 'timeout'] as const;
export type MachineState = (typeof machineStates)[number];

/** Waypoints the bot can physically be standing on. `null` means in transit. */
export const waypoints = ['hold', 'peek'] as const;
export type Waypoint = (typeof waypoints)[number];

export const obsSchema = z.object({
  t: z.literal('obs'),
  bot: z.number().int(),
  hp: z.number(),
  visible: z.boolean(),
  moving: z.boolean(),
  /** Metres. The plugin converts from GoldSrc units. */
  dist: z.number(),
  enemyHp: z.number(),
  footsteps: z.boolean(),
  /** Seconds, or -1 if never seen this round. */
  sinceSeen: z.number(),
  roundLeft: z.number(),
  weaponReady: z.boolean(),
  atWaypoint: z.enum(waypoints).nullish(),
  /**
   * Seconds the bot's crosshair has been continuously on the enemy, 0 the
   * moment it is not. Optional only so an older plugin build still parses;
   * without it the bot can never fire, because the machine reads it as aim
   * that has not settled.
   */
  onTarget: z.number().optional(),
});

export const roundStartSchema = z.object({ t: z.literal('round_start'), bot: z.number().int() });
export const botDiedSchema = z.object({ t: z.literal('bot_died'), bot: z.number().int() });
export const enemyDiedSchema = z.object({ t: z.literal('enemy_died'), bot: z.number().int() });
export const roundEndSchema = z.object({
  t: z.literal('round_end'),
  bot: z.number().int(),
  result: z.enum(['win', 'loss', 'draw']),
});

export const inboundSchema = z.discriminatedUnion('t', [
  obsSchema,
  roundStartSchema,
  botDiedSchema,
  enemyDiedSchema,
  roundEndSchema,
]);

export const intentSchema = z.object({
  t: z.literal('intent'),
  bot: z.number().int(),
  state: z.enum(machineStates),
  /** One-shot: true only in the message emitted when the machine accepted `enemy.shoot`. */
  fire: z.boolean(),
  /** Monotonic per bot, so the plugin can discard stale packets. */
  seq: z.number().int(),
});

export type Obs = z.infer<typeof obsSchema>;
export type Inbound = z.infer<typeof inboundSchema>;
export type Intent = z.infer<typeof intentSchema>;
export type RoundResult = z.infer<typeof roundEndSchema>['result'];

/** One packet per line; a datagram may carry several. */
export function encode(packet: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(packet)}\n`);
}

/** Parses a datagram into packets, dropping lines that do not match the protocol. */
export function decode<T extends z.ZodType>(schema: T, datagram: Buffer | string): Array<z.infer<T>> {
  const out: Array<z.infer<T>> = [];
  for (const line of String(datagram).split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // Malformed JSON on a UDP socket is the network's business, not ours.
    }
  }
  return out;
}
