/**
 * The sidecar process: one UDP socket in, one stream of intents out, one bot
 * actor per `bot` id. It holds no game state of its own — the plugin is the
 * world and the machine is the brain.
 */
import dgram from 'node:dgram';
import type { JevClient } from '@xstate/jev';
import { createBot, type Bot } from './bot';
import { HOST, INTENT_PORT, OBS_PORT, decode, encode, inboundSchema, type Intent } from './protocol';

export interface SidecarOptions {
  client: JevClient;
  /** Where perception arrives. 0 binds an ephemeral port (tests). */
  inPort?: number;
  /** Where intents are sent. */
  outPort?: number;
  host?: string;
  heartbeatMs?: number;
  /** The aim gate, in seconds on target. 0 turns it off; see `createBot`. */
  aimSeconds?: number;
  log?: (message: string) => void;
}

export interface Sidecar {
  /** The bound port, useful when `inPort` was 0. */
  port: number;
  bots: Map<number, Bot>;
  close: () => Promise<void>;
}

export async function startSidecar(options: SidecarOptions): Promise<Sidecar> {
  const {
    client,
    inPort = OBS_PORT,
    outPort = INTENT_PORT,
    host = HOST,
    heartbeatMs = 1000,
    aimSeconds,
    log,
  } = options;

  const socket = dgram.createSocket('udp4');
  const bots = new Map<number, Bot>();

  const emit = (intent: Intent) => socket.send(encode(intent), outPort, host);

  const botFor = (id: number): Bot => {
    let bot = bots.get(id);
    if (!bot) {
      bot = createBot({ id, client, emit, aimSeconds, log });
      bots.set(id, bot);
      bot.start();
    }
    return bot;
  };

  socket.on('message', (datagram) => {
    for (const packet of decode(inboundSchema, datagram)) botFor(packet.bot).handle(packet);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(inPort, host, resolve);
  });
  const port = socket.address().port;
  log?.(`sidecar listening on ${host}:${port}, intents to ${host}:${outPort}`);

  const beat = setInterval(() => {
    for (const bot of bots.values()) bot.heartbeat();
  }, heartbeatMs);
  beat.unref?.();

  return {
    port,
    bots,
    close: async () => {
      clearInterval(beat);
      for (const bot of bots.values()) bot.stop();
      await new Promise<void>((resolve) => socket.close(resolve));
    },
  };
}
