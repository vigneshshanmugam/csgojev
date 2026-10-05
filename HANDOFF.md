# Handoff: where this stands

Read `PLAN.md` first — §0 "Ground truth" is 19 numbered facts that each cost real
time to discover, and several of them fail *silently* if you don't know them. This
file is only the current state and the one remaining task.

## What this is

Jev (TypeSafe System One — a non-generative model returning typed, calibrated
probability distributions over enumerated choices) drives a bot inside a real
Counter-Strike 1.6 server. The thesis is a three-way split: an **XState machine**
defines what is physically legal, the **engine** does fast physics at 100 tick, and
**Jev** is a slow (~95ms measured) tactical brain that only ever picks among events
the machine will accept. It never aims and never moves.

The match being built: 1v1, Jev's bot vs the game's own zBot on Easy, on a small
purpose-built map, headless and repeatable, reported as a win rate.

## Verified working

Everything below was observed, not assumed.

- **The server.** `ghcr.io/balintsoos/cs16-web-server:latest` under
  `--platform linux/386` on arm64. Game content is baked in from the free HLDS
  download — no Steam purchase. Browser client works.
- **The plugin host.** metamod-p loads and hosts our plugin. (metamod-r *segfaults*
  this engine — see `PLAN.md` §0.3.)
- **The body.** `jev_spawn` creates a fake client that joins a team, holds an AWP
  (`model=urban`, `health=100`, `solid=3`, `weaponmodel=models/p_awp.mdl`) and moves
  under `pfnRunPlayerMove`.
- **The opponent.** A zBot spawns from our hand-authored `cs16/gamedata/BotProfile.db`
  and plays de_dust2 properly — takes the bomb, walks to a site, plants. Required the
  `czero` gamedir spoof (`PLAN.md` §0.14); without it no bot cvar exists at all.
- **Both fighting.** Kills in both directions, logged. With placeholder engine-side
  aiming the zBot won **10–2**. That is our baseline to beat, and nobody tuned it.
- **The map.** `cs16/map/out/jev_duel.bsp`, generated from `src/game/map.ts`, compiles
  leak-free and boots. Aim-map scale: 906 units (23m, ~3.6s run), 276 wide.
- **The brain.** `cs16/sidecar/` runs the real machine and real Jev. **86/86 tests**,
  typecheck clean. Live: median ~95ms decision latency. The aim gate took the rusher
  from 1/5 to 4/5 (`PLAN.md` §2.5).

## Not verified

**The plugin has never talked to the sidecar.** That is the whole remaining gap.

## The one remaining task

`cs16/plugin/jevbot.cpp` already contains the full bridge — UDP send/receive, intent
parsing, state-driven movement, and commands `jev_bridge`, `jev_duel`, `jev_stop`,
`jev_report`, `jev_tune`. It compiles. It was never run end to end.

It **hardcodes the pre-shrink geometry** and was built minutes before the map changed:

```c
static const float HOLD_X = -3.2f * UNITS_PER_METRE;   // now -2.2
static const float PEEK_X =  1.2f * UNITS_PER_METRE;   // now  0.9
static float g_roundLen = 95.0f;                       // now 45
... (enemySpeed > 98.0f && dist < 35.0f)               // footstep range, now 12m
```

So:

1. Replace those constants with values **derived from `src/game/map.ts`** at build
   time, not copied. The copying is what broke; fix the class, not the instance.
   Conversion is `proto.x -> x`, `proto.z -> y`, height -> `z`, times `39.37`, no
   offsets. Current values: `PLAYER_SPAWN` `91, 118`, `ENEMY_HOLD` `-87, -787`,
   `ENEMY_PEEK` `35, -787`.
2. Rebuild, `docker cp` the regenerated `.bsp` in, reload.
3. Run the duel against an Easy zBot and report a real win rate.

**Sanity check:** a rifler crosses the whole lane in ~3.6s and the bot's hold-to-peek
swing is 3.1m. If the bot walks for ten seconds it is still on the old map. This
failure is silent — stale waypoints on the new map just walk the bot into a wall.

## The wire protocol

Authoritative definition: `cs16/sidecar/src/protocol.ts`. Newline-delimited JSON over
UDP. Plugin → sidecar on **27100** at ~20Hz; sidecar → plugin on **27101** on every
state change plus a 1Hz heartbeat.

```json
{"t":"obs","bot":1,"hp":100,"visible":true,"moving":false,"dist":42.5,
 "enemyHp":100,"footsteps":false,"sinceSeen":3.2,"roundLeft":80.0,
 "weaponReady":true,"atWaypoint":"peek","onTarget":0.42}
{"t":"intent","bot":1,"state":"peeking","fire":false,"seq":12}
```

`dist` is in **metres** (plugin divides by 39.37). **`onTarget`** is seconds of
continuous crosshair-on-enemy, zeroed the instant that breaks — **omit it and the bot
never fires**, because the machine refuses `enemy.shoot` until aim settles. Send level
values at 20Hz; the sidecar derives edges itself. `fire` is one-shot. Discard packets
with a stale `seq`.

## Running things

```sh
pnpm dev                      # Three.js prototype: human vs Jev, in browser
pnpm duel:cs 5 rusher         # headless duel, live Jev, prints decisions + win rate
pnpm sidecar                  # the brain: perception on 27100, intents on 27101
pnpm test                     # 86/86
cs16/map/build.sh --lit       # regenerate + recompile the map (~4s)
```

Jev needs `TYPESAFE_API_KEY`; source it with `set -a && . ./.env && set +a` and never
print it. Unset falls back to a mock client.

Plugin build:

```sh
cd cs16 && docker run --rm --platform linux/386 -v "$PWD":/work -w /work/plugin \
  i386/debian:bookworm-slim sh -c "apt-get update -qq && apt-get install -y -qq g++ make && make"
cp plugin/Release/jevbot_mm_i386.so overlay/addons/jevbot/
```

## Traps that waste hours

All in `PLAN.md` §0; the ones that bite hardest:

- **The console prints nothing for unknown commands.** Silence is never success.
- **`docker cp` maps in, never bind-mount**, then `chmod 777 /xashds/cstrike/maps` as
  root. The server runs as uid 1000, the directory is owned by 999, and it *segfaults*
  when it can't write `<map>.bsp.ztmp` as a browser connects.
- **Publish `-p $PORT:$PORT`, unique per server.** The client is handed `IP:PORT`
  literally, so two servers sharing a `PORT` send browsers to the same one.
- **There is no A2S responder.** Drive the console via `-i` + `docker attach` through a
  FIFO, all in one shell invocation — background jobs don't survive between calls.
- **Drive the console with logging off**, or `IsCareerMatch` warnings flood it.

## Open questions

- `server/jevApi.ts` is a Vite `configureServer` middleware, so `/api/jev` exists in
  `pnpm dev` but not in a built `dist/`. Needs porting before anything is deployed.
- Nothing is committed — `git status` shows the whole tree untracked.
- After the first real rounds: tune turn rate and acquire time, which decide whether
  the bot reads as human or as a turret.
