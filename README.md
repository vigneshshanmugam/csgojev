# csgojev

csgojev puts Jev in the AWPer's seat of a Counter-Strike 1.6 duel against the game's own bot (zBot), then measures whether Jev's decisions are what win the rounds. Short answer so far: Jev plays as well as a hand-written script that reads the same cues, but we could not show that it plays better than one. [Does Jev help?](#does-jev-help) has the full write-up.

## What Jev is

Jev is TypeSafe's System One model. It does not write text and it does not aim. You give it the current situation and a closed list of options, and it returns a probability for each option in about 100ms. In this repo the options are the AWPer's tactical moves: peek out, stop, shoot, fall back behind cover, or wait.

## How it works

The bot is split into three layers, and each one does only what it is fast at:

| Layer | Owns | Speed |
| --- | --- | --- |
| XState machine (`src/game/enemyMachine.ts`) | Which moves are legal right now | instant |
| Jev | Which legal move to take | ~100ms |
| GoldSrc engine | Movement, aim, bullets, hitboxes, line of sight | 100 tick |

Jev never moves the bot and never aims, so a slow brain sits on top of a fast game without getting in its way. The machine also keeps Jev honest. For example, `enemy.shoot` is only offered once the zBot is visible and the scope has settled. Before that gate, the bot burned its first AWP shot of every round at about 6% hit chance, because firing was legal the moment it stopped.

```
holding ──peek──▶ peeking ──arrived──▶ scoped ──shoot──▶ cycling
   ▲                 │  counterStrafe ──┘  │                 │
   └──────fallBack───┴──────────────────────┴───weaponReady──┘
```

| Move Jev can pick | What it means |
| --- | --- |
| `enemy.peek` | Swing out into the lane (0.55s, exposed and inaccurate while moving) |
| `enemy.counterStrafe` | Stop dead part way out: less exposed, accurate at once |
| `enemy.shoot` | Fire the AWP. One hit kills, then a 1.5s bolt cycle |
| `enemy.fallBack` | Step back behind the pillar |
| noop | Wait. Nothing can hit you, but you see nothing either |

Along with the moves, Jev sees what the bot can sense: distance to the rifler in 2m steps, whether he is in sight or moving, footsteps, seconds since last contact, both players' HP, the round clock and how settled the scope is.

Inside real CS 1.6, a Metamod plugin gives Jev's bot a body in a dedicated server, the zBot plays the other side, and a TypeScript sidecar runs the machine and calls Jev:

```
CS 1.6 server (docker, metamod-p)
  └─ jevbot plugin (C++)  ── obs, UDP :27100 @ ~20Hz ──▶  sidecar (TS)
       Jev's bot + zBot       ◀── intent, UDP :27101 ──   machine + Jev
```

The glue between XState and Jev (`createJevLogic`) is the [`@xstate/jev`](packages/jev/README.md) package in this repo.

## Results against the stock zBot

Jev's wins out of 24 rounds per cell, same weapon on both sides:

| zBot difficulty | AWP | M4A1 |
| --- | --- | --- |
| 0 Easy | 22 | 19 |
| 1 Normal | 20 | 16 |
| 2 Hard | 18 | 12 |
| 3 Expert | 16 | 13 |
| total | 76/96 | 60/96 |

For comparison, the same bot with placeholder aiming and no Jev lost 2 to 10 against Easy. At 24 rounds per cell the margin is about ±18 points, so the trend holds but single cells do not. The rifle path is untuned.

This table shows the whole system works. It does not isolate Jev, because the comparison bot had worse aiming, not a different brain. The next section is about isolating Jev.

## Does Jev help?

### Short answer

Jev works, and it plays as well as a hand-written script that reads the same cues, without anyone writing that rule for it. On the one map where a cue mattered, it also avoided a mistake the hand-written script made. What we could not show is Jev beating a well-written script: every edge we found in these duels, a one-line rule captured just as well.

| Claim | Status |
| --- | --- |
| Jev drives a real-time bot | Proven |
| Jev reaches script-level play with no rules written for it | Proven |
| Jev beats a well-written script | Not shown |
| Jev reads situations, not just labels | Not tested yet |

The rest of this section explains how we got there, run by run.

### How we tested

Winning rounds does not mean Jev is the reason, because the bot body, the aim gate and the map all contribute. So `cs16/compare.sh` keeps all of that fixed and swaps only the brain that picks the moves:

- Same map, same zBot opponent and difficulty (Expert unless noted).
- Same bot body from `cs16/body.env`: AWP, 220°/s turn, scoped, no pre-aim.
- Same XState machine, so every brain is offered the same legal moves at the same moments.

The brains live in `cs16/sidecar/src/brains.ts`:

| Brain | What it does |
| --- | --- |
| `jev` | The real model, given the situation and the legal moves |
| `rule` | Hand-written AWPer. Holds until the attacker is close, 6s of quiet or a low clock, then peeks. Falls back when scoped below 50 HP with the attacker in sight |
| `rush` | Peeks at once, then plays like `rule` |
| `rushhold` | `rush` that never falls back while scoped |
| `random` | A uniform pick among the legal moves |
| `left`, `right` | Two-lane map: always peek that lane first |
| `cue` | Two-lane map: peek the lane the footsteps came from, otherwise play like `rule` |
| `cuehold` | `cue` with the scoped retreat removed |
| `sweep` | Two-lane map: ignores the cue, opens left, drops a lane that shows nothing for 3s and tries the other |
| `cueswitch` (3s, 5s, 7s) | `cuehold` that drops a lane after a fixed time without a sighting |
| `cuecheck` | `cuehold` that marks a lane dry whenever a peek ends unseen, and trusts a sighting over the label |

Three rules came out of early mistakes, and every run since follows them:

- **Balanced slots.** We run up to four isolated CS servers in parallel. `compare-balanced.sh` gives every brain every slot in a Latin-square order, because the first pilot ran one brain per slot and its headline gap turned out to be a slot effect.
- **Pre-registration.** Each run folder has a `PREREGISTRATION.md` with the question, the predictions and the reading rule, written before the run. The result is appended after, including the predictions that missed.
- **A stopping rule.** `compare-sequential.sh` adds passes of 100 rounds per brain and stops by Haybittle-Peto efficacy (|z| >= 3.29), non-binding futility (conditional power under 10%), or two-sided 0.05 at a cap of 400.

Every decision is logged with what the brain saw, the options, the choice and how the round ended (`runLog.ts`). `analyze.ts` turns the logs into a `report.md`: win rates with Wilson intervals, Fisher exact tests, outcomes by slot, route and cue condition, and a per-situation table of what each brain chose. Each run's meta line records the plugin hash, the git commit and a dirty flag. Win rates below count draws as non-wins.

### Phase 1: one lane, no lever

The first map, `jev_duel`, is a single 23m lane with one peek spot, so the only real decision is when to peek.

| Run | Rounds per brain | Result |
| --- | --- | --- |
| Pilot, AWP vs AWP, Hard, one brain per slot | 20 | jev 15-5, rush 13-7, rule 7-13, random 7-13 |
| Balanced, AWP vs AWP, Expert | 21 | jev 13-8, rule 12-9, rush 11-10 |
| Lever check, AWP vs AWP | 100 | rush 56%, rule 52% |
| Lever check, AWP vs M4A1, sequential | 100 (futility stop) | rush 56%, rule 55% |
| Lever check, AWP vs M4A1, held zBot | 400 (cap) | rush 54%, rule 48%, z 1.63 |

The pilot looked like a win for Jev: 15-5 against `rule`'s 7-13 (p=0.025). Once every brain played every slot, the gap shrank to +4.8 points against `rule` and +9.5 against `rush` (p of 1.0 and 0.76). It was mostly a slot effect.

Before spending more API calls on Jev, we asked whether this duel had anything to win at all. If peeking at once (`rush`) and waiting for a cue (`rule`) win equally often, the timing of the peek does not decide rounds, and a brain that times it better has nothing to gain. They tied in all three checks:

- Against a pushing zBot with an AWP.
- Against a pushing zBot with an M4A1, the rifler Jev's brief describes. This one stopped for futility at the first look, at 3% conditional power.
- Against a held zBot that aims and fires but never advances (`jev_zhold 1`), not significant after the full 400 rounds.

The held run was also the test for a mixed-opponent design. The trend favoured `rush` against both opponents, so a mix of the two has nothing to adapt to.

Two smaller observations from these runs:

- Jev opens like `rush`. It peeks from cover almost every round, and where it departs from the scripts it does so at 30 to 45% confidence. Part of that is instructed: the brief says waiting has a price.
- Falling back while hurt comes up in about 5 of 100 rounds, so that decision cannot move the overall win rate by more than about 5 points.

### Phase 2: two lanes, a cue to read

`jev_split` was built to create a decision that matters. It has two lanes split by a wall, and a peek spot for each lane that cannot see the other one. Each round the plugin (`jev_zroute`) walks the zBot down a random lane at running speed, then releases it to play on its own. The bot hears which side the footsteps come from, and Jev sees that as `footstepsFrom: left|right`. The brief describes the two lanes but deliberately does not say what footsteps mean, so following them has to come from Jev, not from the instructions.

The checks without API calls came first, to confirm there was a lever:

| Check | Rounds per brain | Result |
| --- | --- | --- |
| `cue` vs `left`, sequential | 100 (efficacy stop, z 3.72) | cue 71%, left 45% |
| `cue` vs `right` | 100 | cue 67%, right 38% |
| `cue` vs `sweep` | 100 | cue 71%, sweep 55% |

`cue` never peeked the wrong lane first, while `sweep` did in 48 of 100 rounds. Reading the cue clearly pays, so the Jev run was worth the API spend.

The Jev run was pre-registered with a primary question (is Jev non-inferior to `cue`, within 10 points) and a secondary one (does Jev beat `sweep`). After a 10-round smoke test that Jev won 9-1, it ran in two looks of 99 rounds per brain on different route seeds:

| Brain | First look (seed 23) | Second look (seed 37) | Combined, 198 rounds | Wrong-lane first peeks |
| --- | --- | --- | --- | --- |
| `jev` | 70-26-3 | 83-16-0 | 153-42-3, 77% | 0/194 |
| `cue` | 64-35-0 | 67-32-0 | 131-67-0, 66% | 0/198 |
| `sweep` | 51-31-17 | 56-36-7 | 107-67-24, 54% | 89/198 |

- Primary: Jev was +11.1 points over `cue`. The one-sided 95% lower bound for the gap is about +3.7 points, well above the -10 point margin, so Jev is non-inferior.
- Secondary: Jev was +23.2 points over `sweep` (p=0.0000016).
- Jev picked the right lane on every first peek it made, without being told what footsteps mean. Median decision latency was 99ms (p90 183ms).

NOTE: Jev's denominator is 194, not 198, because 4 rounds in one block got no Jev decisions at all during an API stall. They were scored as non-wins (3 draws and 1 loss), so they count against Jev, not for it.

### What Jev's lead over `cue` is made of

`cue` inherits `rule`'s scoped retreat: fall back when hurt with the attacker in sight. In the Jev run, `cue` fell back in 131 decisions and Jev in 15, and `cue` never won a round after falling back while its aim was settling. So we built `cuehold`, which is `cue` with only that rule removed, and ran it against `cue` on the same route seeds, 200 rounds each with no API calls:

| Brain | W-L-D | Win rate |
| --- | --- | --- |
| `cue` | 132-66-2 | 66% |
| `cuehold` | 142-58-0 | 71% |
| `jev` (earlier run, same seeds) | 153-42-3 | 77% |

- `cue` scored 66% again, so its number in the Jev run was not an outlier.
- Removing the retreat is worth about 5 points (p about 0.28), roughly half of Jev's +11.
- Jev's remaining +6.3 over `cuehold` is not significant (p about 0.15), and it comes from a single look. On seed 23, Jev and `cuehold` tied at 70 wins each. On seed 37, Jev won 83 against 72. Settling 6 points properly would take about 600 rounds per brain.

This is the strongest point in Jev's favour so far. A person wrote `cue`, it shipped with a rule that loses rounds, and Jev did not make that mistake. It is one instance, not a pattern.

### Noisy cue: nothing past lane-matching

A clean footsteps label reduces the task to mapping a label to a lane. To test reading rather than mapping, we corrupted the label in the sidecar (`cs16/sidecar/src/cueNoise.ts`). Each round it was either true, hidden, or pointing at the wrong lane, the same for every brain on a slot. Sightings stayed true. The gate before any Jev run: a script that cross-checks the label has to beat `cuehold` by at least 8 points, otherwise there is nothing for a smarter brain to recover.

| Run | Cue noise | Rounds per brain | Result |
| --- | --- | --- | --- |
| Noise only, no cross-check | 25% hidden, 25% flipped | 100 | cue 50%, cuehold 50% |
| 3s cross-check | 25% hidden, 25% flipped | 99 | cue 57%, cuehold 54%, cueswitch 52% |
| 5s and 7s cross-checks | 10% hidden, 40% flipped | 99 | cuehold 53%, cueswitch5 63%, cueswitch7 52% |
| Cross-check without a timer | 10% hidden, 40% flipped | 100 | cuehold 56%, cuecheck 56% |

What each run showed:

1. **Noise bites.** Both scripts that trust the label fell 16 to 21 points and won only 25% of flipped rounds.
2. **A 3-second timer gives up too early.** On true-cue rounds `cueswitch` won 59% against `cuehold`'s 74%. About one zBot in five takes longer than 3s to show up, and by then the script had already left the right lane.
3. **The 5 and 7-second timers raced the machine.** The machine's scoped state falls back to cover on its own after 5 seconds (`EXPOSED_MS`), and the script restarted its timer on every re-peek. So the 7-second timer never fired and played exactly like `cuehold`, and the 5-second one only sometimes beat the reflex. Its +10 points was that race, not a real recovery.
4. **Without a timer there is still nothing.** `cuecheck` marks a lane dry whenever a peek ends unseen, reflex included, and it peeked both lanes in 34 of 40 flipped rounds. It cut flipped-round draws from 25 to 10, but the fights it found were about even (17 wins, 13 losses), and it gave back a few true and hidden rounds. Net, a tie.

Part of the reason is the map. After its route the released zBot stops about 16m out and waits, often out of sight of both peek spots. Correct-lane peeks that started 8s or more into a round found it in only 43 of 111 tries, against 147 of 188 for earlier ones. A wrong first guess therefore costs a draw rather than a death, and many of those draws cannot be won by any lane choice. That caps what any cross-check, Jev included, could recover here, so we did not run Jev on the noisy cue.

### Things we got wrong along the way

These were caught in the logs and fixed before the next run. Several of them would have changed the headline if missed.

- **Slot effect.** The pilot's 40-point gap came from running one brain per server. Fixed with balanced slots.
- **A plugin build without `jev_zhold`.** The hold silently did nothing. `compare.sh` now refuses to start unless the plugin confirms the hold and the enemy weapon.
- **A dirty flag that was always true,** because a tracked benchmark file changed during runs. It now checks code paths only.
- **A zBot spawn out of sight.** One of four spawns sat behind the player's cover crate, so a held zBot never showed up and a quarter of that run's rounds were draws. The spawn row has moved.
- **The bot aimed through walls.** While scoped or cycling it aimed at the zBot's live position whenever it was alive, and `g_lastSeenAt` tracked it behind walls. This inflated absolute win rates but did not bias comparisons inside a run. It was fixed before the two-lane runs.
- **A noise roll replayed in every block.** The first noisy-cue run keyed the roll on round number only, so all 8 blocks saw the same 25 rolls. It is now keyed on the slot as well.
- **Stalled blocks.** Two blocks in one noisy-cue run stopped with the machine stuck. They were rerun, and the partial blocks were left out.
- **A wrong explanation.** The 5-second gain was first explained as a recovery window that closes when the zBot's route ends. The logs showed the timer racing the exposure reflex instead, and the run's pre-registration carries the correction.

NOTE: every `jev_split` run up to `7285786` used a placeholder navmesh: `cs16/gamedata/maps/jev_split.nav` was byte-identical to `jev_duel.nav` (added in `0a4cd15` to stop Condition Zero from auto-generating a mesh). A real mesh, learned with `cs16/learn-nav.sh jev_split`, replaced it afterwards. A 20-round smoke test on the real mesh did not change the released zBot's behaviour: drawn rounds still end with the zBot 16 to 18m from the AWPer, and the share of late peeks (10s or later) that see it within 6s was 5 of 32 (16%), against 27 of 213 (13%) on the placeholder. So the placeholder mesh was not what parked the zBot. The scripted route completed in only 3 of 20 rounds (`zroute complete` in the server log); in rounds the zBot survived it often never reached the final waypoint, and 16 to 18m from the AWPer is about mid-lane on its route. A 1Hz trace of the zBot's distance (`OBS_TRACE`, `cs16/sidecar/src/obsTrace.ts`) found the cause: on right-route rounds it walked for 2 to 3 seconds and then stopped for good at 17m, which is `x=3.2, z=-3.3`. The right cover crate starts at `x=3.6` and the zBot's hull is about 0.4m either side, so it clipped the crate's corner. Moving the lane routes inward to `x=±2.8` fixed it. Two 14-round traces on the new route (same `left` brain, seed 53) against one on the old: right-route draws fell from 3 of 4 to 1 of 8, and the left lane changed too. A brain that always peeks left won 9 of 10 left-route rounds on the old route and 12 of 20 on the new one (7-3 and 5-5), and left-route rounds ran several seconds longer. So the zBot was handing out easy kills on both lanes. These samples are small, but the direction is the same in all of them. A regression test (`split.test.ts`, hull clearance) now fails on the old legs.

That means every two-lane result so far, including the clean-cue ones (Jev 77%, `cue` 66%, `cuehold` 71%, `sweep` 54%) and the noisy-cue null, was measured against a zBot that snagged on both crates. Comparisons inside each run stay fair, because every brain faced the same opponent, but a working zBot can change which decisions matter and the absolute rates. A clean lever check on the fixed route (two passes, 198 rounds per arm, same route seed) gave `cue` 71%, `cuehold` 70% and `sweep` 64%, with no draws. The cue-over-`sweep` gap is +7 points (p about 0.12), against +16 on the old route, so reading the cue still seems to pay but less, and the earlier Jev margins (+11 over `cue`, +23 over `sweep`) should not be quoted as results about a working opponent.

NOTE: the route seed is passed to `compare.sh` but not yet written into the run's meta line, so each run's seed is recorded only in its pre-registration.

### What this proves, and what it doesn't

Proven:

- Jev can drive a real-time bot: about 100ms per decision, only legal moves, 76 of 96 AWP rounds against the stock zBot.
- Jev reaches the level of a hand-written cue reader with no rules written for it, on a cue its brief never explains.
- On this evidence, Jev avoided a rule that cost a human-written script about 5 points.

Not proven:

- That Jev beats a well-written script. Its +6 over `cuehold` comes from one look and is not significant.
- That Jev reads situations rather than labels. The only lever we found was a direct label-to-lane mapping, and on the noisy cue no script could recover anything, so there was nothing left for Jev to show.
- Anything about ordinary matches. `jev_split` is a cue task we designed, and Jev's one-lane behaviour is partly shaped by its brief.

Not tested:

- Jev in the rifler's seat.
- Adaptation across rounds. A `jevmem` brain that sees recent rounds exists but never ran in a comparison.
- Jev steering the shipped zBot itself. The design is in [`cs16/STEERING.md`](cs16/STEERING.md) and is not built.

### What's next

The one experiment that can show Jev helps is a duel where no fixed rule wins. This is in progress:

- Change `jev_zroute` so the zBot keeps pushing toward the AWPer after its route. A wrong or late read then costs a death instead of a draw, and when to switch lanes becomes a real trade-off.
- Optionally mix a pushing and a holding opponent from round to round, with cues that are only partly reliable.
- Compare Jev against the best of a tuned family of scripts, for example a sweep of switch timers, not against one script. Otherwise a win could just mean a weak script, as `cue`'s retreat rule showed.
- Keep the same gate: if no script variant beats `cuehold` without API calls, there is no lever and no Jev run.

Not worth doing on current evidence: a 600-round run to settle the 6 points, Jev on the current noisy cue, or `jevmem`.

Run logs, reports and pre-registrations are written to `cs16/runs/` (gitignored). [`cs16/FINDINGS.md`](cs16/FINDINGS.md) keeps the same results as a running log.

## Two ways to watch it

**Browser prototype** (`pnpm dev`). You play the rifler and Jev is the AWPer, in Three.js. It runs the same machine, aim gate and map geometry as the CS sidecar, with CS 1.6 numbers: AK-47 damage and fire rate, GoldSrc movement (221 u/s, `sv_accelerate` 5, `sv_friction` 4) and a 90 degree FOV. `?sens=` sets mouse sensitivity (default 3, the CS default).

**Real Counter-Strike 1.6.** The plugin, a dedicated server in Docker and the sidecar described above. You can watch Jev against a zBot, or join from the browser as CT and play it yourself.

## Running it

```sh
pnpm install
cp .env.template .env          # TYPESAFE_API_KEY; without it a mock Jev is used
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

NOTE: the CS side needs Docker and a populated `cs16/vendor/` (metamod-p, sdhlt, WADs). `SLOT=n` runs another isolated server on its own ports. Pair it with `SLOT=n pnpm sidecar`.

## Repo layout

```
packages/jev/        @xstate/jev: lets Jev pick the next event for an XState actor
src/game/
  enemyMachine.ts    the machine and Jev's brief, shared by the prototype and the CS sidecar
  map.ts split.ts    level geometry for both maps, the single source for prototype, CS maps and waypoints
src/                 Three.js prototype
server/jevApi.ts     keeps the API key server-side for the prototype
scripts/duel.ts      headless prototype duel
cs16/
  sidecar/           perception in, decision out (protocol, bot, brains, analysis)
  plugin/            jevbot.cpp: Jev's bot, zBot hooks, UDP bridge
  map/               generates the CS maps from src/game and compiles the .bsp
  overlay/ gamedata/ Metamod config, BotProfile.db, navmeshes
  duel.sh bench.sh   live matches and difficulty sweeps
  compare*.sh        brain comparisons: single, balanced across slots, sequential with a stopping rule
  FINDINGS.md        does Jev help: what the comparisons showed
  STEERING.md        design for steering a stock zBot with Jev (not built)
```
