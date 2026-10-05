/**
 * The sidecar process: one UDP socket in, one stream of intents out, one bot
 * actor per `bot` id. It holds no game state of its own — the plugin is the
 * world and the machine is the brain.
 */
import dgram from 'node:dgram';
import type { JevClient, JevDecision } from '@xstate/jev';
import { createBot, type Bot, type Move } from './bot';
import { HOST, INTENT_PORT, OBS_PORT, decode, encode, inboundSchema, type Inbound, type Intent } from './protocol';

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
  /** Sees every packet from the plugin, before the bot does: the run log hooks in here. */
  onPacket?: (packet: Inbound) => void;
  onDecision?: (bot: number, decision: JevDecision) => void;
  onMove?: (bot: number, move: Move) => void;
  /** Show each bot's brain how its recent rounds went. */
  memory?: boolean;
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
    onPacket,
    onDecision,
    onMove,
    memory,
  } = options;

  const socket = dgram.createSocket('udp4');
  const bots = new Map<number, Bot>();

  const emit = (intent: Intent) => socket.send(encode(intent), outPort, host);

  const botFor = (id: number): Bot => {
    let bot = bots.get(id);
    if (!bot) {
      bot = createBot({
        id,
        client,
        emit,
        aimSeconds,
        log,
        onDecision: onDecision && ((d) => onDecision(id, d)),
        onMove: onMove && ((m) => onMove(id, m)),
        memory,
      });
      bots.set(id, bot);
      bot.start();
    }
    return bot;
  };

  socket.on('message', (datagram) => {
    for (const packet of decode(inboundSchema, datagram)) {
      onPacket?.(packet);
      botFor(packet.bot).handle(packet);
    }
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
