# Does Jev help? Findings so far

## Summary

On the original one-lane duel, Jev plays at the level of a tuned script, but we could not show that it plays better than one. Across three lever checks, fixed scripts with opposite openings (`rush` peeks at once, `rule` waits for a cue) never separated, so there was no policy edge for a smarter brain to find.

The richer split-lane duel changed that. `jev_split` gives the bot two peek lanes and a route cue through `footstepsFrom`. At the pre-registered cap there, Jev was non-inferior to the hand-written cue reader and beat a no-cue sweep script: `jev` 153/198, `cue` 131/198, `sweep` 107/198. This shows Jev can follow a built-in cue in a designed duel well enough to reach cue-reader-level play without the cue rule being hand-written.

## What we measured

The question was whether Jev's decisions, not the body around them, win rounds. To isolate that, `cs16/compare.sh` swaps only the decision-maker and keeps everything else fixed: the same map (`jev_duel`), the same bot body (`cs16/body.env`: AWP, 220°/s turn, scoped, no pre-aim), the same XState machine, and the same zBot opponent.

The brains (`cs16/sidecar/src/brains.ts`) all answer the same question Jev answers, over the same legal options:

- `jev`: the real model.
- `rule`: a hand-written AWPer. Holds until a cue (attacker close, 6s of quiet, or a low clock), then peeks.
- `rush`: peeks at once, then plays like `rule`.
- `rushhold`: like `rush`, but never falls back while scoped.
- `random`: a uniform pick among the legal moves.

Every decision is logged with the situation Jev saw, the options, the choice and the outcome (`runLog.ts`), and `analyze.ts` reports win rates with Wilson intervals, Fisher exact tests, and a per-situation breakdown of what each brain chose.

Two design rules came out of early mistakes:

- **Balanced slots.** `compare-balanced.sh` runs every brain on every server slot in a Latin-square order. The first pilot ran one brain per slot, and its headline gap turned out to be mostly a slot effect.
- **Pre-registered stopping.** `compare-sequential.sh` adds passes of 100 rounds per brain and stops by a rule written down before the run: Haybittle-Peto efficacy at |z| >= 3.29, non-binding futility below 10% conditional power, and two-sided 0.05 at a cap of 400. Each run folder keeps a `PREREGISTRATION.md` with the predictions and the result appended after.

## Results

| Run | Setup | Rounds per brain | Result |
| --- | --- | --- | --- |
| Pilot | AWP vs AWP, Hard, one brain per slot | 20 | jev 15-5, rush 13-7, rule 7-13, random 7-13 |
| Balanced | AWP vs AWP, Expert, three slots | 21 | jev 13-8, rule 12-9, rush 11-10 |
| Lever check | AWP vs AWP, Expert, four slots | 100 | rush 56%, rule 52% |
| Lever check | AWP vs M4A1, Expert, four slots, sequential | 100 (futility stop) | rush 56%, rule 55%, z 0.14 |
| Lever check | AWP vs M4A1, Expert, held zBot, sequential | 400 (cap) | rush 54%, rule 48%, z 1.63 |
| Split lever | AWP vs M4A1, Expert, `jev_split`, routed zBot | 100 | cue 71%, sweep 55% |
| Split Jev | AWP vs M4A1, Expert, `jev_split`, routed zBot | 198 (cap) | jev 77%, cue 66%, sweep 54% |

Win rates count draws as non-wins. Run folders are under `cs16/runs/`, named by date.

NOTE: these absolute win rates were measured before `cs16/plugin/jevbot.cpp` stopped aiming at hidden zBots. The comparisons inside each run remain fair because every brain used the same body, but the bot had two wallhack-style aim leaks: while scoped or cycling it aimed at the zBot's live origin whenever it was alive, and `g_lastSeenAt` updated every frame even when the zBot was behind a wall. Runs after that fix are not directly comparable to the table above.

## What the results show

**The pilot's gap was a slot effect.** Jev beat `rule` by 40 points in the pilot (p=0.025). Once every brain played every slot, Jev was +4.8 points against `rule` and +9.5 against `rush`, with Fisher p of 1.0 and 0.76. Detecting a gap that size needs more than 400 rounds per brain.

**The opening is not a lever.** If waiting for a cue and peeking at once lead to the same win rate, then the timing of the peek does not decide rounds, and a brain that times it better has nothing to gain. That held in all three lever checks:

- Against a pushing zBot with an AWP, `rush` 56% and `rule` 52% over 100 rounds each.
- Against a pushing zBot with an M4A1 (the rifler Jev's brief describes), `rush` 56/100 and `rule` 55/100. The run stopped for futility at the first look, at 3% conditional power.
- Against a held zBot (`jev_zhold 1`, which aims and fires but never advances), `rush` 54% and `rule` 48% after the full 400 rounds each, z 1.63, not significant.

The held run was the test for a mixed-opponent design. If a held zBot wanted a different opening than a pushing one, a brain that reads cues could beat both fixed scripts on a mixed schedule. It didn't: the trend favours `rush` against both opponents, so a mixed schedule has nothing to adapt to.

**The split-lane duel has a lever.** `jev_split` adds left and right peek lanes. A scripted zBot route makes footsteps identify the side before contact, then releases the zBot back to stock hunting after the route. In the no-API lever check, `cue` beat `sweep` 71/100 to 55/100. `cue` had 0/100 wrong-side first peeks; `sweep` had 48/100. That made the Jev run worth the API spend.

**Jev cleared the split-lane check.** At the 198-round cap, `jev` went 153-42-3, `cue` 131-67-0 and `sweep` 107-67-24. The primary comparison was non-inferiority to `cue` within 10 points; Jev finished 11.1 points ahead, and the approximate one-sided lower bound for `jev - cue` was about +3.7 points, above the -10 point margin. Against `sweep`, Jev was +23.2 points (p=0.0000016), which settles the secondary comparison. Jev had 0/194 wrong-side delivered first peeks; `cue` had 0/198 and `sweep` had 89/198.

**The fall-back decision is too rare to matter.** In the first 100 `rush` rounds, falling back while the scope settled preceded losses more often for `rule` (13%) than for `rush` (0%). That was confounded, because both scripts fall back only below 50 HP. The confirmatory `rushhold` run was stopped before looking at any win rate: only 5 of 100 rounds reached that branch, so it can move the overall win rate by about 5 points at most, below what 400 rounds per brain can detect.

**Jev opens like `rush`.** It peeks from cover almost every round, and where it departs from what the scripts would do, it does so at 30 to 45% confidence. Part of this is instructed: the brief Jev gets says waiting has a price and describes a rifler walking in, so peeking early is the answer the brief points to.

## What this does not show

- **It does not show that Jev is no better than a script.** A null at 400 rounds per brain rules out gaps larger than about 10 points between the scripts, not smaller ones, and Jev itself was only run at 20 to 21 rounds per brain.
- **The split result is a designed cue-label test.** `jev_split` uses `jev_zroute` to drive the zBot down a lane before releasing it, and the state includes `footstepsFrom: left|right`. That answers whether Jev can map an explicit cue label to the right lane in a game we designed, not whether it reads ambiguous audio or improves the shipped zBot in an ordinary match.
- **It does not cover other maps or opponents.** The original null runs used `jev_duel`, one lane with one peek spot, against zBot on Expert or Hard. A held zBot is also not how the stock bot plays a real match.
- **It does not test adaptation across rounds.** Jev sees each situation fresh. A `jevmem` brain that sees a summary of the last 5 rounds exists, but we kept it out of the comparisons until a lever existed, so it is untested.

## Setup flaws found along the way

These were caught in the logs and fixed before the next run. Runs record the plugin hash, the git commit and a dirty flag in their `meta` line, so the affected runs can be told apart from the rest.

- **A plugin build was missing `jev_zhold`.** The hold silently did nothing. `compare.sh` now refuses to start unless the plugin confirms the hold, and the same for `jev_enemy_weapon`.
- **The dirty flag was always true,** because a tracked benchmark file changed during runs. It now looks only at code paths.
- **A zBot spawn sat out of sight of the peek spot.** One of the zBot's four rotating spawns was behind the player-cover crate. A pushing zBot walked out of it, but a held one stayed hidden, so a quarter of the held run's rounds ran out as draws (103 per brain). Both brains hit it equally, so the comparison stayed unbiased, but those rounds carried no information. The spawn row in `cs16/map/gen.ts` now starts where the whole player hull is in view, and a 20-round smoke test against a held zBot had no draws.
- **The bot aimed through walls.** The scoped and cycling states aimed at the zBot's live origin whenever it was alive, and a missing brace made `g_lastSeenAt` track the zBot's true position even when `EyeVisible` was false. That inflated absolute win rates. It did not bias brain-vs-brain comparisons inside one run, because all brains shared the same body.

## What would change the answer

The split result is the first positive result, but it is still narrow. The next ways to strengthen or falsify it:

- **A less built-in cue.** The current route exposes the side through `footstepsFrom`, so the task is close to "map the cue to the lane." A stronger duel would make the cue partial or delayed, with repositioning after first contact.
- **A rifler brain for Jev.** Jev would play the attacker's seat instead of the AWPer's.
- **Steering the stock zBot** (`cs16/STEERING.md`). This now looks less promising than the split duel because the choice surface is smaller.

NOTE: the spawn fix changes where the zBot starts in every run, held or pushing, so results from before and after `815437a` are not directly comparable.
