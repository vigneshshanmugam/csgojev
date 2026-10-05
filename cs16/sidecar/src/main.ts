/**
 * The sidecar as the plugin will run it: perception in on 27100, intent out on
 * 27101, one brain per bot id.
 *
 *   pnpm sidecar          # mock Jev unless TYPESAFE_API_KEY is set
 *   SLOT=1 pnpm sidecar   # pairs with SLOT=1 cs16/duel.sh: ports 27110/27111
 *   BRAIN=rule pnpm sidecar                  # jev (default) | jevmem | rule | rush | cue | sweep | random | mock
 *   LAYOUT=split pnpm sidecar                # use split-lane machine/events
 *   RUN_LOG=cs16/runs/x.jsonl pnpm sidecar   # write every decision and round outcome
 *
 * OBS and INTENT override the slot's ports, matching cs16/slot.sh. RUN_META is
 * a JSON object copied into the log's first line (body settings, opponent).
 */
import { makeClient } from './jevClient';
import { brains, isJev, type BrainName } from './brains';
import { openRunLog } from './runLog';
import { startSidecar } from './sidecar';
import { INTENT_PORT, OBS_PORT } from './protocol';

const slot = Number(process.env.SLOT ?? 0);
const inPort = Number(process.env.OBS ?? OBS_PORT + 10 * slot);
const outPort = Number(process.env.INTENT ?? INTENT_PORT + 10 * slot);
const brain = (process.env.BRAIN ?? 'jev') as BrainName;
if (!brains.includes(brain)) throw new Error(`BRAIN must be one of ${brains.join(', ')}`);
const layout = (process.env.LAYOUT ?? 'duel') as 'duel' | 'split';
if (!['duel', 'split'].includes(layout)) throw new Error('LAYOUT must be duel or split');

const handle = await makeClient(brain);
if (isJev(brain) && !handle.live && process.env.RUN_LOG) {
  throw new Error(`BRAIN=${brain} with RUN_LOG needs TYPESAFE_API_KEY: a comparison against the mock is not a Jev result`);
}
console.log(isJev(brain) ? (handle.live ? `(live Jev${brain === 'jevmem' ? ', with memory' : ''})` : '(no TYPESAFE_API_KEY: mock Jev)') : `(brain: ${brain})`);

const runLog = process.env.RUN_LOG
  ? openRunLog(process.env.RUN_LOG, { brain, live: handle.live, slot, ...JSON.parse(process.env.RUN_META ?? '{}') })
  : undefined;

const sidecar = await startSidecar({
  client: runLog ? runLog.client(handle.client) : handle.client,
  inPort,
  outPort,
  log: (message) => console.log(message),
  onPacket: runLog?.packet,
  onDecision: runLog?.decision,
  onMove: runLog?.move,
  memory: brain === 'jevmem',
  layout,
});

const stop = async () => {
  await sidecar.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
