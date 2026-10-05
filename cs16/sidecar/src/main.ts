/**
 * The sidecar as the plugin will run it: perception in on 27100, intent out on
 * 27101, one brain per bot id.
 *
 *   pnpm sidecar        # mock Jev unless TYPESAFE_API_KEY is set
 */
import { makeClient } from './jevClient';
import { startSidecar } from './sidecar';
import { INTENT_PORT, OBS_PORT } from './protocol';

const { client, live } = await makeClient();
console.log(live ? '(live Jev)' : '(no TYPESAFE_API_KEY: mock Jev)');

const sidecar = await startSidecar({
  client,
  inPort: OBS_PORT,
  outPort: INTENT_PORT,
  log: (message) => console.log(message),
});

const stop = async () => {
  await sidecar.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
