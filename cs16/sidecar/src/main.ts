/**
 * The sidecar as the plugin will run it: perception in on 27100, intent out on
 * 27101, one brain per bot id.
 *
 *   pnpm sidecar          # mock Jev unless TYPESAFE_API_KEY is set
 *   SLOT=1 pnpm sidecar   # pairs with SLOT=1 cs16/duel.sh: ports 27110/27111
 *
 * OBS and INTENT override the slot's ports, matching cs16/slot.sh.
 */
import { makeClient } from './jevClient';
import { startSidecar } from './sidecar';
import { INTENT_PORT, OBS_PORT } from './protocol';

const slot = Number(process.env.SLOT ?? 0);
const inPort = Number(process.env.OBS ?? OBS_PORT + 10 * slot);
const outPort = Number(process.env.INTENT ?? INTENT_PORT + 10 * slot);

const { client, live } = await makeClient();
console.log(live ? '(live Jev)' : '(no TYPESAFE_API_KEY: mock Jev)');

const sidecar = await startSidecar({
  client,
  inPort,
  outPort,
  log: (message) => console.log(message),
});

const stop = async () => {
  await sidecar.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
