# Sidecar

The brain, outside the engine. The Metamod plugin sends perception over UDP and
gets back the machine's current state; everything fast stays in GoldSrc.

```
pnpm sidecar          # listen on 27100, intents to 27101
pnpm duel:cs 5        # 5 rounds against the fake plugin, no engine
pnpm duel:cs 5 jiggler
```

Both use live Jev when `TYPESAFE_API_KEY` is set (env or `.env`), the mock
otherwise. The key is read here and never leaves the process.

## Wire

Newline-delimited JSON, one packet per line, a datagram may carry several.
Fixed: the plugin is written against it and the two halves share no code.
`protocol.ts` is the only definition; it validates with zod and drops anything
off-protocol rather than throwing on a hostile socket.

| direction | port | packets |
| --- | --- | --- |
| plugin → sidecar | 27100 | `obs` at ~20Hz, `round_start`, `bot_died`, `enemy_died`, `round_end` |
| sidecar → plugin | 27101 | `intent` on every state change plus a 1Hz heartbeat |

`intent.fire` is a one-shot, true only in the message emitted when the machine
accepted `enemy.shoot`. `seq` is monotonic per bot so the plugin can discard
stale packets. One actor per `bot` id; v1 uses bot 1.

`obs.onTarget` is seconds, a float: how long the bot's crosshair has been
continuously on the enemy, reset to 0 the moment it is not (lost sight, or the
bot turned or moved). The plugin accumulates frame time while the aim is within
its hit cone and the eye-to-eye trace is clear. It is optional on the wire so
an older build still parses, but a plugin that omits it will never fire: the
machine reads a missing field as aim that has not settled, and says so once in
the log.

## What the engine owns now

`enemyMachine` is shared with the Three.js prototype rather than forked, taking
an optional timing argument. Two of its delays used to simulate physics the
renderer performed, and the real engine performs them instead:

- `peeking` ends on `world.arrived`, sent when `obs.atWaypoint` first reads
  `peek` during a swing. The timer is raised to `PEEK_SAFETY_MS` as a net.
- `cycling` ends on `world.weaponReady`, sent on the weapon's busy → ready
  edge. The timer is raised to `BOLT_SAFETY_MS` as a net.
- `EXPOSED_MS` is untouched: a reflex, not simulated physics.
- Death and round end come from lifecycle packets, not a game loop.
- `enemy.shoot` needs `onTarget >= AIM_MIN_SECONDS` as well as a visible
  player. Whether the scope has settled is physics, so it belongs beside the
  existing visibility guard rather than in Jev's judgement. Jev is also shown
  the aim as one of four readings, because standing still for a beat is a
  different decision when a shot is coming than when nothing is.

Both are sent on edges only. An event the machine ignores still wakes the Jev
agent, so repeating them at 20Hz would reset its settle window and it would
never decide again.

## Fake plugin

`fakePlugin.ts` speaks the same protocol over the same sockets, with the
duel geometry from `src/game/map.ts` and a scripted rifler
(`rusher | holder | jiggler`) from `scripts/duel.ts`. The bot's legs take a
jittered time to cross between waypoints, so arrival is physical rather than a
fixed 550ms, the weapon runs its own 1.5s bolt, and the scope only settles
while the bot is stopped and looking. It is the test harness and the eval
harness: `round()` returns the round's result, states, and the hit probability
of every shot actually taken. `pnpm duel:cs 5 rusher --no-aim-gate` replays the
same rounds with the gate off, which is how the gate was measured.
