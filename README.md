# csgojev

Jev plays Counter-Strike 1.6. It takes the AWPer's seat in a 1v1 against the game's own zBot, on a small map built for the duel, and it wins most of the rounds. Whether Jev's decisions are the reason is a separate question, and [Does Jev help?](#does-jev-help) answers it with what we measured so far.

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

## Results against the stock zBot

Jev wins out of 24 rounds per cell, same weapon on both sides:

| zBot difficulty | AWP | M4A1 |
| --- | --- | --- |
| 0 Easy | 22 | 19 |
| 1 Normal | 20 | 16 |
| 2 Hard | 18 | 12 |
| 3 Expert | 16 | 13 |
| total | 76/96 | 60/96 |

Decision latency is a median of about 100ms (p90 about 160 to 200ms). With placeholder engine-side aiming, before Jev was driving, the same bot lost 2 to 10 against Easy. At n=24 per cell the margin is about ±18pp, so the trend holds and single cells do not. The rifle path is untuned.

## Does Jev help?

Not shown yet, and not ruled out. Jev reaches the level of a tuned script without any hand-written thresholds, but the duel is too coarse to tell it apart from one.

To isolate Jev, `cs16/compare.sh` swaps only the decision-maker (`cs16/sidecar/src/brains.ts`) while the body, machine, map and zBot stay fixed:

- `rule`: a hand-written AWPer with fixed thresholds.
- `rush`: peek at once, otherwise `rule`.
- `random`: a uniform pick among the legal moves.
- `jev`: the real model.

`compare-balanced.sh` runs every brain on every server slot, so a slow server cannot favour one brain. `compare-sequential.sh` adds passes of 100 rounds per brain and stops by the rule written into `analyze.ts` (Haybittle-Peto efficacy, non-binding futility, two-sided 0.05 at the cap). Each run folder keeps its logs, `report.md` and a pre-registration.

| Run | Setup | Result |
| --- | --- | --- |
| Pilot, 20 rounds each | AWP vs AWP, Hard | jev 15-5, rush 13-7, rule 7-13, random 7-13 |
| Balanced, 21 rounds each | AWP vs AWP, Expert, three slots | jev 13-8, rule 12-9, rush 11-10 |
| Lever check, 100 rounds each | AWP vs M4A1, Expert, four slots | rush 56, rule 55 (3 draws) |

What the runs show:

- The pilot's gap between Jev and `rule` (p=0.025) disappeared once brains were balanced across slots. It was mostly a slot effect.
- In the balanced run, Jev against `rush` is +9.5 points (p=0.76) and against `rule` is +4.8 points (p=1.0). Both are noise, and detecting a gap that size would take over 400 rounds per brain.
- In the lever check, `rush` and `rule` tied (z=0.14), so the opening policy is not a lever in this duel. That run stopped for futility at the first look, which rules out gaps of about 15 points or more, not smaller ones.
- Jev opens like `rush`: it peeks from cover every round. Where it departs from the rules it does so at 30 to 45% confidence.
- Falling back while hurt comes up in about 5% of rounds, so it cannot move the overall win rate by more than about 5 points.

What is not tested:

- Jev against the best script at a round count that can see a small edge.
- Jev steering the shipped zBot itself. A spike showed that `jev_zhold` can pin a zBot while it keeps aiming and firing. The design for the full experiment is in [`cs16/STEERING.md`](cs16/STEERING.md), and its `stock` arm may hit the same lack of a lever.
- Cross-round adaptation. Jev sees each situation fresh and is not told how earlier rounds went. A `jevmem` brain exists but is parked.

The next step is to change the game so choices matter more: a mixed schedule of rushing and held zBots, or a richer duel with more peek lines.

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
  compare*.sh        brain comparisons: single, balanced across slots, sequential with a stopping rule
  runs/              logs, reports and pre-registrations per comparison (gitignored)
  STEERING.md        design for steering a stock zBot with Jev
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
cs16/compare-sequential.sh rush rule 100 400 "3 4 6 7"   # brain comparison with a stopping rule
```

The CS side needs Docker and a populated `cs16/vendor/` (metamod-p, sdhlt, WADs). `SLOT=n` runs a second isolated server on its own ports; pair it with `SLOT=n pnpm sidecar`.
