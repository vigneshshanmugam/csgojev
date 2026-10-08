# Does Jev help? Findings so far

## Summary

On the original one-lane duel, Jev plays at the level of a tuned script, but we could not show that it plays better than one. Across three lever checks, fixed scripts with opposite openings (`rush` peeks at once, `rule` waits for a cue) never separated, so there was no policy edge for a smarter brain to find.

The richer split-lane duel changed that. `jev_split` gives the bot two peek lanes and a route cue through `footstepsFrom`. At the pre-registered cap there, Jev was non-inferior to the hand-written cue reader and beat a no-cue sweep script: `jev` 153/198, `cue` 131/198, `sweep` 107/198. This shows Jev can follow a built-in cue in a designed duel well enough to reach cue-reader-level play without the cue rule being hand-written.

About half of Jev's lead over `cue` turned out to be `cue`'s own retreat rule. With that rule removed, `cuehold` won 71%, and the remaining 6 points to Jev are not separable at 200 rounds per brain. Corrupting the cue hurt the scripts, but a script that cross-checks the label tied `cuehold`, so the noisy cue has nothing left for Jev to win and no Jev run was made on it.

The claim this supports: Jev matches a hand-written cue reader on a clean cue. On the fixed route it won 75% to `cuehold`'s 67% (+8.6, p 0.076, unresolved by the pre-registered rule); the one decision that clearly mattered, the half-settled shot, is worth roughly 2 of those points, and the rest is unexplained. It does not support Jev beating a tuned script on either map.

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
| Split retreat check | same, no Jev | 200 | cue 66%, cuehold 71% |
| Split noisy cue | same, cue hidden 25% / flipped 25% | 99 | cue 57%, cuehold 54%, cueswitch (3s timer) 52% |
| Split noisy cue, timers | same, cue hidden 10% / flipped 40% | 99 | cuehold 53%, cueswitch5 63%, cueswitch7 52% |
| Split noisy cue, no timer | same, cue hidden 10% / flipped 40% | 100 | cuehold 56%, cuecheck 56% |

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

**Jev cleared the split-lane check.** At the 198-round cap, `jev` went 153-42-3, `cue` 131-67-0 and `sweep` 107-67-24. The primary comparison was non-inferiority to `cue` within 10 points; Jev finished 11.1 points ahead (see the retreat note below for what that gap is made of), and the approximate one-sided lower bound for `jev - cue` was about +3.7 points, above the -10 point margin. Against `sweep`, Jev was +23.2 points (p=0.0000016), which settles the secondary comparison. Jev had 0/194 wrong-side delivered first peeks; `cue` had 0/198 and `sweep` had 89/198.

**On a working zBot Jev was ahead of the best script by an unresolved margin, and chose differently in few decisions.** Fixed-route rerun (seeds 81 and 82, 198 rounds per brain, all requests live): `jev` 149-49 (75%), `cuehold` 132-66 (67%), `sweep` 124-74 (63%). Jev is +8.6 over `cuehold` (CI -0.3 to +17.5, p 0.076, ahead in both passes; pre-registered reading: unresolved) and +12.6 over `sweep` (p 0.009). Replaying its decisions through `cuehold`, they differ in 41 of 1,207: 25 half-settled shots where `cuehold` waits, 12 fall-backs where it waits, 4 bolt-cycle waits where it falls back. Jev won all 25 rounds with a half-settled shot against 86% for `cuehold` whenever it reached that aim, worth roughly 2 points (a ballpark: Jev's wins against `cuehold`'s rate in different rounds, picked by whether they reached that moment). The other 6 are in rounds with identical choices: noise or timing (Jev peeks 0.27 s in against 0.17 s; its median request latency is 95 ms), untested. Jev counter-strafes unseen in 182 of 182 decisions, like `cuehold`. The earlier +11 and +23 are not results about a working opponent.

**Part of Jev's lead over `cue` is the retreat rule.** `cue` inherits the scoped retreat from `rule` (fall back below 50 HP with the attacker in sight). Rounds where it fell back were won 0% of the time, and it fell back in 131 decisions against Jev's 15. `cuehold` is `cue` with only that rule removed. Over 200 rounds each, `cue` won 66% and `cuehold` 71% (+5, p about 0.28), against Jev's 77%. So about half of Jev's +11 over `cue` is the retreat, and the other 6 points (p about 0.15) cannot be separated from noise at this size. Detecting 6 points would take about 600 rounds per brain.

**A noisy cue hurts the scripts, and there is nothing to recover.** In a check without API calls, the side label was hidden in 25% of rounds and flipped in 25%. `cue` and `cuehold` fell to 50% in the first run and 57% and 54% in the second, which used a different roll mix; on flipped rounds they won 15 to 27%. `cueswitch`, a script that drops a lane that shows nothing for a fixed time, did not help: its 3-second timer gave up on true lanes before the zBot arrived, and its 5 and 7-second timers raced the machine's own 5-second exposure reflex (`EXPOSED_MS`), so the 7-second one never fired and played exactly like `cuehold`. The one apparent gain (`cueswitch5`, +10 points, p about 0.15) was that race. `cuecheck` removes the timer: it marks a lane dry whenever a peek ends in cover without a sighting, reflex included, and trusts a sighting over the label. It peeks both lanes in 34 of 40 flipped rounds and still ties `cuehold` at 56% over 100 rounds each. On flipped rounds it turns 15 draws into fights, which are about even (17 wins, 13 losses), and it loses a few true and hidden rounds. One caveat on the whole noisy-cue family: after its route the released zBot stops about 16m out and waits, often out of sight of both peek spots. In the `cuecheck` run, correct-lane peeks that started 8s or more into the round found it in only 43 of 111 tries, against 147 of 188 for earlier ones. A wrong first guess therefore costs a draw more often than a death, and many of those draws cannot be won by picking the other lane. That caps what any cross-check, Jev included, could recover on this map. The noisy cue offers no lever past lane-matching, so no Jev run was made on it.

**The fall-back decision is too rare to matter.** In the first 100 `rush` rounds, falling back while the scope settled preceded losses more often for `rule` (13%) than for `rush` (0%). That was confounded, because both scripts fall back only below 50 HP. The confirmatory `rushhold` run was stopped before looking at any win rate: only 5 of 100 rounds reached that branch, so it can move the overall win rate by about 5 points at most, below what 400 rounds per brain can detect.

**Jev opens like `rush`.** It peeks from cover almost every round, and where it departs from what the scripts would do, it does so at 30 to 45% confidence. Part of this is instructed: the brief Jev gets says waiting has a price and describes a rifler walking in, so peeking early is the answer the brief points to.

## What this does not show

- **It does not show that Jev is no better than a script.** A null at 400 rounds per brain rules out gaps larger than about 10 points between the scripts, not smaller ones, and on `jev_duel` Jev itself was only run at 20 to 21 rounds per brain.
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

The split result is the first positive result, but it is narrow, and the noisy-cue checks found no further lever on this map. The next ways to strengthen or falsify it:

- **A zBot that keeps coming.** After its route the released zBot parks, often out of sight, so a wrong lane guess costs a draw. If it kept pushing, a wrong or late read would cost a death, and the timing of a lane switch would become a choice no single fixed rule gets right. That is plugin work in `jev_zroute`. The same gate applies first: a script without API calls has to beat `cuehold` before Jev runs.
- **A rifler brain for Jev.** Jev would play the attacker's seat instead of the AWPer's.
- **Steering the stock zBot** (`cs16/STEERING.md`). This now looks less promising than the split duel because the choice surface is smaller.

NOTE: every `jev_split` run up to `7285786` used a placeholder navmesh: `cs16/gamedata/maps/jev_split.nav` was byte-identical to `jev_duel.nav` (added in `0a4cd15` to stop Condition Zero from auto-generating a mesh). A real mesh, learned with `cs16/learn-nav.sh jev_split`, replaced it afterwards. A 20-round smoke test on the real mesh did not change the released zBot's behaviour: drawn rounds still end with the zBot 16 to 18m from the AWPer, and the share of late peeks (10s or later) that see it within 6s was 5 of 32 (16%), against 27 of 213 (13%) on the placeholder. So the placeholder mesh was not what parked the zBot. The scripted route completed in only 3 of 20 rounds (`zroute complete` in the server log); in rounds the zBot survived it often never reached the final waypoint, and 16 to 18m from the AWPer is about mid-lane on its route. A 1Hz trace of the zBot's distance (`OBS_TRACE`, `cs16/sidecar/src/obsTrace.ts`) found the cause: on right-route rounds it walked for 2 to 3 seconds and then stopped for good at 17m, which is `x=3.2, z=-3.3`. The right cover crate starts at `x=3.6` and the zBot's hull is about 0.4m either side, so it clipped the crate's corner. Moving the lane routes inward to `x=±2.8` fixed it. Two 14-round traces on the new route (same `left` brain, seed 53) against one on the old: right-route draws fell from 3 of 4 to 1 of 8, and the left lane changed too. A brain that always peeks left won 9 of 10 left-route rounds on the old route and 12 of 20 on the new one (7-3 and 5-5), and left-route rounds ran several seconds longer. So the zBot was handing out easy kills on both lanes. These samples are small, but the direction is the same in all of them. A regression test (`split.test.ts`, hull clearance) now fails on the old legs.

That means every two-lane result so far, including the clean-cue ones (Jev 77%, `cue` 66%, `cuehold` 71%, `sweep` 54%) and the noisy-cue null, was measured against a zBot that snagged on both crates. Comparisons inside each run stay fair, because every brain faced the same opponent, but a working zBot can change which decisions matter and the absolute rates. A clean lever check on the fixed route (two passes, 198 rounds per arm, same route seed) gave `cue` 71%, `cuehold` 70% and `sweep` 64%, with no draws. The cue-over-`sweep` gap is +7 points (p about 0.12), against +16 on the old route, so reading the cue still seems to pay but less, and the earlier Jev margins (+11 over `cue`, +23 over `sweep`) should not be quoted as results about a working opponent. A follow-up on fresh seeds (`cuewait`, a cue reader that finishes the peek instead of stopping part way) found no gain: 69% against `cuehold` 70% and `sweep` 65%. The left-route gap that suggested it did not replicate, so it was noise from a split chosen after the fact. Across all four fixed-route passes (396 rounds per arm) `cuehold` is about 6 points over `sweep`. Jev against the fixed-route zBot (fresh seeds 81 and 82, 198 rounds per arm, 1,198 live requests, no errors, no draws): `jev` 149-49 (75%), `cuehold` 132-66 (67%), `sweep` 124-74 (63%). Jev is +8.6 points over `cuehold` (95% CI -0.3 to +17.5, p 0.076, ahead in both passes), which is short of both "matches" and a clear win, and +12.6 over `sweep` (p 0.009). It still counter-strafes every time it peeks unseen (182 of 182), so it did not find the full peek, and it picked the correct lane first in 198 of 198 rounds.

NOTE: the spawn fix changes where the zBot starts in every run, held or pushing, so results from before and after `815437a` are not directly comparable.
