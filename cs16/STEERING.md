# Steering a stock zBot with Jev

Design for the second experiment. Not built yet. The first experiment (`compare.sh`) asks whether Jev beats Jev-free brains on our own bot body. This one asks the question we started with: does Jev make the shipped bot better?

## Goal

Put a stock zBot in the AWPer seat and let Jev decide only when it holds and when it is released. zBot keeps its own navigation, aim, and trigger finger. Compare against the same zBot with no steering.

## What is verified

A spike hooked `pfnRunPlayerMove` in `jevbot.cpp`. `jev_zhold 1` zeroes forward and side move for every fake client that is not Jev's bot, and passes the view angles and buttons through.

- A held zBot stays at its origin for as long as the hold lasts.
- Its view angles keep changing while held, so it keeps looking around.
- On `jev_zhold 0` it moves again within a frame or two (speed 102, then 232).
- Held and total move counts increment at about 55 frames a second.

## What is not verified

- A held zBot fires at a target it can see. The buttons are passed through, so it should, but the spike never gave it a sight line.
- A zBot can be placed at `ENEMY_HOLD` at round start and behave sanely from there. By default it spawns at the player end of the map.
- Re-holding after a release looks like "fall back". Hold pins the zBot where it is, so it cannot retreat to cover.

## Design

**Seats.** The zBot under test is the AWPer at `ENEMY_HOLD`. The attacker is a second stock zBot at `PLAYER_SPAWN` on the same difficulty in every arm. Jev's fake client is not used, so the body is identical across arms by construction.

**Levers.** Two, both from the existing hook:

| Jev picks | Effect on the AWPer zBot |
| --- | --- |
| `hold` | `jev_zhold 1`: pinned at `ENEMY_HOLD`, still aims and fires |
| `release` | `jev_zhold 0`: plays its own game, which is to hunt |

Release is the peek. Hold after a release is weaker than the machine's `fallBack`, because the zBot stops where it is rather than retreating. A later step could teleport it back to cover or use `bot_goto_mark`, but not in v1.

**Per-bot gate.** The hook currently gates all non-Jev fake clients. It has to gate by edict so that only the AWPer is held and the attacker is never touched. This is a small change: `jev_zhold <slot> 0|1`, or a `jev_zbot_role` that marks which fake client is the AWPer.

**The machine.** A reduced machine with two states, `holding` and `released`, and events `zbot.hold` and `zbot.release`. It reuses the same perception as `enemyMachine.ts` (distance, visibility, footsteps, seconds since seen, HP, round clock). Jev's brief changes to describe a bot that cannot shoot from cover and cannot retreat: holding is safe but loses to the clock, releasing commits the zBot to its own aggression.

**Plumbing.** The plugin already sends `obs` to the sidecar and applies `intent` packets. v1 maps `state: "holding"` to `jev_zhold 1` and any other state to `0`, so the protocol does not change. The sidecar picks a machine by `MACHINE=zbot`.

## Arms

All arms run the same attacker zBot, difficulty, weapon, map and round count, and log with `runLog.ts`.

| Arm | AWPer | Tests |
| --- | --- | --- |
| `stock` | zBot, never held | the shipped bot |
| `jev` | zBot gated by Jev | does Jev improve the stock bot |
| `rule` | zBot gated by the rule brain | does Jev beat a hand-written gate |
| `random` | zBot gated by random picks | does gating alone change anything |
| `hold` | zBot held for the whole round | lower bound: does camping alone beat the clock |

`stock` against `jev` is the headline comparison. `rule` and `random` guard against crediting Jev for what any sensible gate would do. `hold` shows whether the attacker simply runs out of time.

## Metrics

- Win rate with Wilson 95% intervals, and Fisher exact p-values between arms, using the existing `analyze.ts`.
- Time to kill and time of first contact, to see whether Jev trades speed for safety.
- Fraction of the round spent held. If Jev holds for 95% of rounds, it is camping, not deciding.
- Jev latency per decision, reported but not a pass/fail criterion.

## Success criteria

- **Jev helps:** `jev` beats `stock` with a Fisher p below 0.05 at the same difficulty.
- **Jev earns it:** `jev` also beats `rule` and `random`, with intervals that do not overlap.
- **Jev does not help:** `jev` is within noise of `stock`. That is a result, and it should be reported as one.

The round count comes from the power line `analyze.ts` already prints for the first experiment. The first comparison's effect size sets the planning number.

## Risks

- **Coarse levers.** Two choices is far less than the four moves Jev picks today. The result may be too weak to show an effect even if Jev's reading of the situation is good.
- **zBot may fight badly from cover.** If a held AWPer cannot see the lane from the hold spot, hold is just waiting, and `stock` may win by rushing.
- **Seat bias.** zBot in the AWPer seat is a different experiment from zBot as the rifler, so numbers do not carry over from `compare.sh`.
- **Spawn placement.** Moving a zBot to `ENEMY_HOLD` needs a teleport at round start, and the bot's own pathing may fight it.
- **Navmesh.** zBot runs on the generated navmesh for `jev_duel`. A very small map may make it behave oddly (also noted for the first experiment).

## Steps

1. Run the sight-line test: hold a zBot with a clear view of a target and confirm it fires.
2. Make the hold per-bot and add the AWPer role.
3. Place the AWPer at `ENEMY_HOLD` at round start and log where it ends up.
4. Add the reduced machine and the `MACHINE=zbot` switch in the sidecar.
5. Extend `compare.sh` with the arms above.
6. Run a pilot at a small round count, check the logs, then run the full comparison.

Steps 1 to 3 need a server. Steps 4 and 5 do not, and can be written and unit-tested while the first comparison runs.
