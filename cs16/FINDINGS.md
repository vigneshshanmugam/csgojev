# Testing whether Jev helps: findings

The running log behind the README's [Testing whether Jev helps](../README.md#testing-whether-jev-helps) section. It keeps every run, including the ones a later fix made obsolete, with the reason they no longer count.

## Summary

Jev reaches the level of the best hand-written script on both duels we built, without anyone writing its rules. It has not beaten that script by a margin we can defend.

- **One lane (`jev_duel`).** Fixed scripts with opposite openings (`rush` peeks at once, `rule` waits for a cue) never separated in three lever checks, so there was no decision for a smarter brain to win.
- **Two lanes (`jev_split`), working zBot.** Jev won 75% (149/198), the best cue-reading script `cuehold` 67% (132/198) and the no-cue `sweep` 63% (124/198). Jev is +8.6 over `cuehold` (95% CI -0.3 to +17.5, p 0.076), which the pre-registered rule calls unresolved, and +12.6 over `sweep` (p 0.009). Its choices matched `cuehold`'s in all but 41 of 1,207 decisions. The one difference that clearly mattered, taking the shot at half-settled aim, is worth roughly 2 points, and the rest is not explained.
- **Two lanes, snagging route.** The first round of two-lane runs (Jev 153/198, `cue` 131/198, `sweep` 107/198, the retreat-rule split and the noisy-cue checks) used a route that made the zBot clip the cover crates and stop. Those numbers are kept below as history, not as results about a working opponent.

## What we measured

The question is whether Jev's decisions, not the body around them, win rounds. `cs16/compare.sh` swaps only the decision-maker and keeps everything else fixed: the map, the bot body (`cs16/body.env`: AWP, 220°/s turn, scoped, no pre-aim), the XState machine and the zBot opponent (Expert unless noted).

The brains live in `cs16/sidecar/src/brains.ts` and all pick from the same legal options:

- `jev`: the real model.
- `rule`: a hand-written AWPer. Holds until the attacker is close, 6s of quiet or a low clock, then peeks. Falls back when scoped below 50 HP with the attacker in sight.
- `rush`: peeks at once, then plays like `rule`. `rushhold` never falls back while scoped.
- `random`: a uniform pick among the legal moves.
- `left`, `right`: two-lane map, always peek that lane first.
- `cue`: peek the lane the footsteps came from, otherwise play like `rule`. `cuehold` is `cue` without the scoped retreat.
- `cuewait`: `cuehold` that finishes the peek instead of stopping part way when nothing is in sight.
- `sweep`: ignores the cue, opens left, drops a lane that shows nothing for 3s.
- `cueswitch` (3s, 5s, 7s), `cuecheck`: `cuehold` variants that cross-check a cue that might be wrong.

Every decision is logged with the situation, the options, the choice and the outcome (`runLog.ts`). `analyze.ts` reports win rates with Wilson intervals, Fisher exact tests, outcomes by slot, route and cue condition, and a per-situation table of what each brain chose. It refuses a run file holding more than one run. Win rates count draws as non-wins.

Every run follows three rules, each learned from an early mistake:

- **Balanced slots.** `compare-balanced.sh` runs every brain on every server slot in a Latin-square order, because the first pilot ran one brain per slot and its gap turned out to be a slot effect.
- **Pre-registration.** Each run folder under `cs16/runs/` keeps a `PREREGISTRATION.md` with the question, predictions and reading rule, written before the run, with the result appended after.
- **A stopping rule** where it fits. `compare-sequential.sh` adds passes of 100 rounds per brain and stops by Haybittle-Peto efficacy at |z| >= 3.29, non-binding futility below 10% conditional power, or two-sided 0.05 at a cap of 400.

## Results

### One lane, `jev_duel`

| Run | Setup | Rounds per brain | Result |
| --- | --- | --- | --- |
| Pilot | AWP vs AWP, Hard, one brain per slot | 20 | jev 15-5, rush 13-7, rule 7-13, random 7-13 |
| Balanced | AWP vs AWP, three slots | 21 | jev 13-8, rule 12-9, rush 11-10 |
| Lever check | AWP vs AWP, four slots | 100 | rush 56%, rule 52% |
| Lever check | AWP vs M4A1, sequential | 100 (futility stop) | rush 56%, rule 55%, z 0.14 |
| Lever check | AWP vs M4A1, held zBot, sequential | 400 (cap) | rush 54%, rule 48%, z 1.63 |

NOTE: these were measured before `cs16/plugin/jevbot.cpp` stopped aiming at hidden zBots (see the setup flaws below). Comparisons inside each run stay fair, but the absolute rates are inflated.

### Two lanes, `jev_split`, fixed route (`0e7462a` and later)

| Run | Route seeds | Rounds per brain | Result |
| --- | --- | --- | --- |
| Clean lever check | 61, run twice | 198 | cue 71%, cuehold 70%, sweep 64% |
| `cuewait` check | 71, 72 | 198 | cuewait 69%, cuehold 70%, sweep 65% |
| Jev run | 81, 82 | 198 | jev 75%, cuehold 67%, sweep 63% |

No draws in any of them.

### Two lanes, `jev_split`, snagging route (history)

| Run | Rounds per brain | Result |
| --- | --- | --- |
| `cue` vs `left`, sequential | 100 (efficacy stop, z 3.72) | cue 71%, left 45% |
| `cue` vs `right` | 100 | cue 67%, right 38% |
| `cue` vs `sweep` | 100 | cue 71%, sweep 55% |
| Jev vs `cue` vs `sweep` | 198 (cap) | jev 153-42-3 (77%), cue 131-67-0 (66%), sweep 107-67-24 (54%) |
| Retreat check | 200 | cue 66%, cuehold 71% |
| Noisy cue, 25% hidden, 25% flipped | 99 | cue 57%, cuehold 54%, cueswitch (3s) 52% |
| Noisy cue, 10% hidden, 40% flipped | 99 | cuehold 53%, cueswitch5 63%, cueswitch7 52% |
| Noisy cue, no timer | 100 | cuehold 56%, cuecheck 56% |

## What the results show

**The pilot's gap was a slot effect.** Jev beat `rule` by 40 points in the pilot (p=0.025). Once every brain played every slot, Jev was +4.8 points against `rule` and +9.5 against `rush`, with Fisher p of 1.0 and 0.76.

**The one-lane opening is not a lever.** If waiting for a cue and peeking at once win equally often, the timing of the peek does not decide rounds, and a brain that times it better has nothing to gain. `rush` and `rule` tied against a pushing AWP zBot, a pushing M4A1 zBot (stopped for futility at 3% conditional power) and a held zBot that never advances (`jev_zhold 1`, z 1.63 after 400 rounds). The held run was also the test for a mixed-opponent design, and the trend favoured `rush` against both opponents, so a mix has nothing to adapt to.

**On the fixed route the cue lever is real but small.** Over the clean lever check and the `cuewait` check (396 rounds per brain), `cuehold` is about 6 points over `sweep` (p 0.11), against 16 on the snagging route. `cuewait` tested whether stopping part way out costs the scripts rounds, and it does not (69% against 70%). The left-route gap that suggested it came from a split I picked after seeing the data, and it did not replicate on fresh seeds.

**Jev on the fixed route is ahead by an unresolved margin.** Pre-registered against `cuehold` (within 5 points means "matches", 5 to 10 is "unresolved") and `sweep` (secondary). Jev won 149-49, `cuehold` 132-66 and `sweep` 124-74, ahead in both passes (+7 and +8). All 1,198 requests were live with no errors or timeouts, median latency 95ms (p90 142ms), and Jev peeked the correct lane first in 198 of 198 rounds.

**Where Jev and `cuehold` differ.** Replaying each of Jev's 1,207 decisions through `cuehold` with the same situation and options, they differ in 41:

- 25 times Jev shot at half-settled aim where `cuehold` waits. Jev won all 25 of those rounds, and 22 of the shots killed within 1.5s. `cuehold` reached that aim in 42 rounds, shot in 6 and won 86%. That puts the shot at roughly 2 of the 8.6 points, a ballpark rather than a measurement, because it compares different rounds picked by whether they reached that moment.
- 12 times Jev fell back where `cuehold` waits (8 with the attacker out of sight, 4 with aim not on him), and 4 times it waited during the bolt cycle where `cuehold` falls back.

In 164 of 198 rounds Jev made exactly the choices `cuehold` would have, so the other 6 points are either noise (the interval reaches zero) or timing. Jev acts about 100ms later than the script because of its request latency, and peeks 0.27s into the round against 0.17s. Whether that helps against a walking zBot was not tested. Peeking with nothing in sight, Jev counter-strafed in 182 of 182 decisions, like `cuehold`.

**Snagging route: `cue`'s retreat rule cost it about 5 points.** `cue` inherited `rule`'s scoped retreat, fell back in 131 decisions against Jev's 15, and won 0% of the rounds where it fell back while its aim was settling. With only that rule removed, `cuehold` won 71% against `cue`'s 66% (p about 0.28). On the fixed route `cue` and `cuehold` tie (71% and 70%), so the rule no longer explains anything there.

**Snagging route: a noisy cue left nothing to recover.** `cueNoise.ts` hid or flipped the footsteps label per round, the same for every brain on a slot. Scripts that trust the label fell 16 to 21 points and won 15 to 27% of flipped rounds. None of the cross-checks beat `cuehold` by the 8 points set as the gate for a Jev run:

- The 3-second timer gave up on true lanes before the zBot arrived.
- The 5 and 7-second timers raced the machine's own 5-second fallback (`EXPOSED_MS`), so the 7-second one never fired, and `cueswitch5`'s +10 points (p about 0.15) was that race.
- `cuecheck` has no timer. It marks a lane dry whenever a peek ends unseen and trusts a sighting over the label. It peeked both lanes in 34 of 40 flipped rounds and still tied `cuehold` at 56%, because the fights it found were about even (17 wins, 13 losses).

The parked zBot capped all of this: correct-lane peeks that started 8s or more into a round found it in only 43 of 111 tries, so a wrong first guess cost a draw rather than a death. This null has not been rechecked on the fixed route.

**The fall-back decision is too rare to matter on one lane.** Only 5 of 100 `rush` rounds reached the scoped-retreat branch, so it can move the win rate by about 5 points at most, below what 400 rounds per brain can detect. The confirmatory `rushhold` run was stopped before looking at any win rate.

**Jev opens like `rush`.** It peeks from cover almost every round, and where it departs from the scripts it does so at 30 to 45% confidence. Part of this is instructed: the brief says waiting has a price and describes a rifler walking in.

## What this does not show

- **That Jev is no better than a script.** 198 rounds per brain can only separate gaps of about 10 points, and the fixed-route gap is 8.6.
- **That Jev reads situations rather than labels.** `jev_split` hands Jev an explicit `footstepsFrom: left|right` in a duel we designed. A one-line rule captures the same mapping.
- **Other maps, opponents or seats.** Only the AWPer seat, only zBot, only two purpose-built maps.
- **Adaptation across rounds.** A `jevmem` brain that sees the last 5 rounds exists but never ran in a comparison.

## Setup flaws found along the way

Each was caught in the logs and fixed before the next run. Runs record the plugin hash, git commit and a dirty flag in their `meta` line, so affected runs can be told apart.

- **A plugin build without `jev_zhold`.** The hold silently did nothing. `compare.sh` now refuses to start unless the plugin confirms the hold and `jev_enemy_weapon`.
- **A dirty flag that was always true,** because a tracked benchmark file changed during runs. It now looks only at code paths.
- **A zBot spawn out of sight.** One of four spawns sat behind the player-cover crate, so a held zBot never showed up and a quarter of the held run's rounds were draws. The spawn row in `cs16/map/gen.ts` moved in `815437a`, so results before and after it are not directly comparable.
- **The bot aimed through walls.** The scoped and cycling states aimed at the zBot's live origin, and a missing brace made `g_lastSeenAt` track it behind walls. Absolute rates were inflated, comparisons inside a run were not.
- **A noise roll replayed in every block.** The first noisy-cue run keyed the roll on round number only. It is now keyed on the slot as well.
- **A placeholder navmesh.** `jev_split.nav` was byte-identical to `jev_duel.nav` up to `7285786`. A real mesh (`cs16/learn-nav.sh jev_split`) replaced it but did not change the parked zBot, so it was not the cause.
- **A route that snagged on the cover crates.** A 1Hz distance trace (`OBS_TRACE`, `cs16/sidecar/src/obsTrace.ts`) showed the zBot stopping for good at `x=3.2, z=-3.3`. Its hull is about 0.4m either side and the crate starts at `x=3.6`. Moving the routes to `x=±2.8` in `0e7462a` fixed both lanes: right-route draws fell from 3 of 4 to 1 of 8, and a brain that always peeks left dropped from 9 of 10 left-route wins to 12 of 20. `split.test.ts` now fails any route within a hull width of a crate.
- **One run written twice into the same folder.** Both passes were complete and were split by their meta lines. `analyze.ts` now refuses such files.
- **A split chosen after seeing the data.** The left-route gap behind `cuewait` did not replicate.

NOTE: the route seed is passed to `compare.sh` but not written into the run's meta line, so each run's seed is recorded only in its pre-registration.

## What would change the answer

The duels so far have too few decisions that matter for a smarter brain to stand out. In order of how much they would tell us:

- **An opponent that adapts.** Blind human play against Jev and against the best script, or a zBot that varies its plan across rounds. A fixed rule is easy to exploit there, so reading the situation would matter. The browser prototype has a best-of-20 Human vs Jev scoreboard, but no blind comparison yet.
- **A confirmation run on `jev_split`.** About 450 rounds per brain on fresh seeds, `jev` against `cuehold` and a `cuehold` with a 100ms delay before each move, to separate Jev's decisions from its latency. Roughly 2,700 requests. Even a clean win would prove a small edge on one map.
- **The noisy cue on the fixed route.** `cuehold` against `cuecheck`, no API calls, with the same 8-point gate before any Jev run.
- **Jev in the rifler's seat,** or steering the stock zBot (`cs16/STEERING.md`, not built).
