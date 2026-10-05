/**
 * End-to-end duel with no engine: the real sidecar, the real protocol, and the
 * fake plugin standing in for Metamod. Same shape the engine harness will take.
 *
 *   pnpm duel:cs            # 1 round, rusher, mock Jev unless TYPESAFE_API_KEY is set
 *   pnpm duel:cs 5 jiggler  # rounds, behaviour
 *   pnpm duel:cs 5 rusher --no-aim-gate   # same rounds with the aim gate off, to compare against
 *   BRAIN=rule pnpm duel:cs 5             # a baseline brain instead of Jev (see brains.ts)
 */
import type { BrainName } from './brains';
import { makeClient } from './jevClient';
import { startSidecar } from './sidecar';
import { openFakePlugin, type Behaviour, type RoundReport } from './fakePlugin';

const rounds = Number(process.argv[2] ?? 1);
const behaviour = (process.argv[3] as Behaviour) ?? 'rusher';
const aimGate = !process.argv.includes('--no-aim-gate');

const brain = (process.env.BRAIN ?? 'jev') as BrainName;
const { client, live } = await makeClient(brain);
console.log(brain !== 'jev' ? `(brain: ${brain})` : live ? '(live Jev)' : '(no TYPESAFE_API_KEY: mock Jev)');

// Both ends ephemeral so a duel never collides with a real sidecar on 27100.
const plugin = await openFakePlugin({ sidecarPort: 0, listenPort: 0, behaviour, roundSeconds: 30, log: (m) => console.log(m) });
const sidecar = await startSidecar({
  client,
  inPort: 0,
  outPort: plugin.port,
  ...(aimGate ? {} : { aimSeconds: 0 }),
  log: (m) => console.log(m),
});
if (!aimGate) console.log('(aim gate off: the machine will offer shots the bot cannot make)');
plugin.setSidecarPort(sidecar.port);

const reports: RoundReport[] = [];
for (let round = 0; round < rounds; round++) {
  console.log(`--- round ${round + 1}/${rounds}`);
  reports.push(await plugin.round({ seed: round + 1 }));
}

const wins = reports.filter((r) => r.result === 'win').length;
const stats = sidecar.bots.get(1)?.stats() ?? { decisions: 0, acted: 0, latencies: [] };
const latencies = [...stats.latencies].sort((a, b) => a - b);

const chances = reports.flatMap((r) => r.chances);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

console.log('---');
for (const r of reports) console.log(`${r.result.padEnd(5)} bot ${r.botHp}hp · player ${r.playerHp}hp · ${r.seconds}s · shots ${r.chances.map((c) => c.toFixed(2)).join(', ') || 'none'} · states ${r.states.join(' -> ')}`);
console.log(`win rate: ${wins}/${reports.length}`);
if (chances.length) {
  console.log(`shot quality: mean p=${mean(chances).toFixed(2)}, worst ${Math.min(...chances).toFixed(2)}, ${chances.length} shots, ${reports.reduce((a, r) => a + r.hits, 0)} hits`);
}
console.log(`jev: ${stats.decisions} decisions, ${stats.acted} acted on, ${stats.decisions - stats.acted} waits`);
if (latencies.length) {
  const median = latencies[Math.floor(latencies.length / 2)];
  console.log(`latency: median ${median}ms, max ${latencies[latencies.length - 1]}ms over ${latencies.length} live requests`);
}

await plugin.close();
await sidecar.close();
process.exit(0);
