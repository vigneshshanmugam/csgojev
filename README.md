# csgojev

Jev plays Counter-Strike 1.6. It takes the AWPer's seat in a 1v1 against the game's own zBot, on a small map built for the duel, and it wins most of the rounds.

Jev is TypeSafe's System One model: a non-generative model that returns calibrated probability distributions over a closed set of choices. It does not write text and it does not aim. In this repo it makes one kind of call, over and over, at about 95ms: given what the bot can sense right now, which of the legal tactical moves should it take next?

## What Jev does here

The bot's whole round comes down to a few decisions: when to leave cover, whether to stop and shoot, and when to get back behind the pillar. Jev makes all of them.

- **Reads the situation.** Distance to the rifler in 2m steps, whether he is in sight, whether he is moving, footsteps through walls, seconds since last contact, both players' HP, the round clock, and how settled the scope is.
- **Weighs risk against waiting.** Holding is safe but loses the round: every second behind the pillar lets the rifler walk closer to clearing the angle. Jev has to take the peek while he is still too far away to win the first shot.
- **Picks only legal moves.** An XState machine decides which events are possible right now. Jev is shown only those, plus a `wait` option, and answers with a probability for each.
- **Knows when to stay quiet.** Below the confidence threshold or on a loop (peek, look, fall back, peek again), it is told about it and can choose something else.

```
holding ──peek──▶ peeking ──arrived──▶ scoped ──shoot──▶ cycling
   ▲                 │  counterStrafe ──┘  │                 │
   └──────fallBack───┴──────────────────────┴───weaponReady──┘
```

| Event Jev can pick | What it means |
| --- | --- |
| `enemy.peek` | Swing out into the lane (0.55s, exposed and inaccurate while moving) |
| `enemy.counterStrafe` | Stop dead part way out: less exposed, accurate at once |
| `enemy.shoot` | Fire the AWP. One hit kills, then a 1.5s bolt cycle |
| `enemy.fallBack` | Step back behind the pillar |
| noop | Wait. Nothing can hit you, but you see nothing either |

## Why the split works

| Layer | Owns | Speed |
| --- | --- | --- |
| **XState machine** | What is physically legal right now | instant |
| **Jev** | Which legal event to take | ~95ms |
| **GoldSrc engine** | Movement, aim, bullets, hitboxes, line of sight | 100 tick |

Jev never moves the bot and never aims, so a slow brain sits on top of a fast game without ever being in its way. The machine also keeps Jev honest:

- `enemy.shoot` is refused unless the player is visible and the scope has settled (`onTarget >= aimSeconds`), so Jev is never offered a shot the bot cannot make.
- Before the aim gate, the bot burned its first AWP shot of every round at about 6% hit chance, because firing was legal the moment it stopped. With the gate the rusher matchup went from 1/5 to 4/5 rounds, and the worst shot taken went from p=0.02 to p=0.64.
- Each option comes with a `lookahead`, computed with the pure `transition()`, describing what the state becomes if Jev takes it. The timed states (peek in 0.55s, bolt cycle) are included.

The machine and the Jev agent (`createJevLogic`) come from [`@xstate/jev`](packages/jev/README.md), which lives in this repo.

## Results

Jev wins out of 24 rounds per cell, same weapon on both sides:

| zBot difficulty | AWP | M4A1 |
| --- | --- | --- |
| 0 Easy | 22 | 19 |
| 1 Normal | 20 | 16 |
| 2 Hard | 18 | 12 |
| 3 Expert | 16 | 13 |
| total | 76/96 | 60/96 |

Decision latency is a median of about 95ms (max 277ms over 18 live requests). With placeholder engine-side aiming, before Jev was driving, the same bot lost 2 to 10 against Easy, so that is the baseline these numbers beat. At n=24 per cell the margin is about ±18pp: the trend holds, single cells do not. The rifle path is untuned.

## Two places to watch it

**Three.js prototype** (`pnpm dev`). You are the rifler, Jev is the AWPer, in the browser. It runs the same machine, aim gate and map geometry as the CS sidecar, with CS 1.6 numbers: AK-47 damage and fire rate, GoldSrc movement cvars (221 u/s, `sv_accelerate` 5, `sv_friction` 4), 90 degree horizontal FOV, and a Dust-style look. `?sens=` sets mouse sensitivity (default 3, the CS default).

**Real Counter-Strike 1.6.** A Metamod plugin gives Jev's bot a body inside a dedicated server, a zBot plays the other side, and a sidecar runs the machine and calls Jev.

```
CS 1.6 server (docker, metamod-p)
  └─ jevbot plugin (C++)  ── obs, UDP :27100 @ ~20Hz ──▶  sidecar (TS)
       Jev's bot + zBot       ◀── intent, UDP :27101 ──   machine + Jev
```

## Repo layout

```
packages/jev/        @xstate/jev: the Jev agent runtime for XState (decide, options, memo, loops)
src/game/
  enemyMachine.ts    the machine and Jev's brief; shared by the prototype and the CS sidecar
  map.ts             level geometry, the single source for the prototype, CS map and waypoints
src/                 Three.js prototype
server/jevApi.ts     keeps the API key server-side
scripts/duel.ts      headless prototype duel
cs16/
  sidecar/           perception in, Jev decision out (protocol, bot, jevClient, fakePlugin)
  plugin/            jevbot.cpp: fake-client bot, zBot hookup, UDP bridge
  map/               generates jev_duel.map from src/game/map.ts and compiles the .bsp
  overlay/ gamedata/ Metamod config, authored BotProfile.db, cached navmesh
  duel.sh bench.sh   full match, and difficulty sweeps
```

## Running it

```sh
pnpm install
cp .env.template .env          # TYPESAFE_API_KEY; unset falls back to a mock Jev
set -a && . ./.env && set +a

pnpm dev                       # browser prototype
pnpm test && pnpm typecheck
pnpm duel:cs 5 rusher          # sidecar vs a scripted opponent, no engine needed

pnpm sidecar                   # the brain: perception :27100, intents :27101
cs16/map/build.sh --lit        # regenerate and compile the map
cs16/plugin/build.sh           # build the plugin (i386 container)
cs16/duel.sh bots 10 0         # live match: 10 rounds vs zBot, difficulty 0-3
cs16/duel.sh human             # join from the browser as CT
cs16/bench.sh 24 "0 1 2 3"     # difficulty sweep
```

The CS side needs Docker and a populated `cs16/vendor/` (metamod-p, sdhlt, WADs). `SLOT=n` runs a second isolated server on its own ports; pair it with `SLOT=n pnpm sidecar`.
