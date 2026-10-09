# csgojev

csgojev stress tests one idea: a slow decision model can play a fast game if a state machine owns what is legal, the engine owns the physics, and the model only picks the next move. Here the model is Jev, the game is Counter-Strike 1.6 and the opponent is the game's own bot (zBot).

The idea holds up. Jev drives the AWPer at about 95ms per decision, beats the stock zBot in 76 of 96 AWP rounds, and on a two-lane map it follows a footsteps cue nobody wrote a rule for. What we could not show is Jev beating a well-written script: against the best one it won 75% to 67%, which our pre-registered rule calls unresolved, and its choices matched that script's in all but 41 of 1,207 decisions. [Testing whether Jev helps](#testing-whether-jev-helps) has the full write-up.

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
| `enemy.fallBack` | Step back behind cover |
| noop | Wait. Nothing can hit you, but you see nothing either |

Along with the moves, Jev sees what the bot can sense: distance to the rifler in 2m steps, whether he is in sight or moving, footsteps and which side they come from, seconds since last contact, both players' HP, the round clock and how settled the scope is.

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

Before Jev and the aim gate, the same bot with placeholder aiming lost 2 to 10 against Easy. At 24 rounds per cell the margin is about ±18 points, so the trend holds but single cells do not. The rifle path is untuned.

This table shows the whole system works. It does not isolate Jev, because the comparison bot had worse aiming, not a different brain. The next section isolates Jev.

## Testing whether Jev helps

### Short answer

Jev reaches the level of the best hand-written script on every duel we built, without anyone writing its rules. It has not beaten that script by a margin we can defend. The duels turned out to have very few decisions that matter, and a one-line rule covers most of them.

| Claim | Status |
| --- | --- |
| Jev drives a real-time bot | Proven |
| Jev reaches script-level play with no rules written for it | Proven |
| Jev beats a well-written script | Not shown. +8.6 points on the working zBot, p 0.076, about 2 of those points trace to one decision |
| Jev reads situations, not just labels | Not tested |

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
| `cuehold` | `cue` with the scoped retreat removed. The best script we found |
| `cuewait` | `cuehold` that finishes the peek instead of stopping part way when nothing is in sight |
| `sweep` | Two-lane map: ignores the cue, opens left, drops a lane that shows nothing for 3s and tries the other |
| `cueswitch` (3s, 5s, 7s), `cuecheck` | `cuehold` variants that cross-check a cue that might be wrong |

Every run follows three rules, each learned from an early mistake:

- **Balanced slots.** We run up to four isolated CS servers in parallel. `compare-balanced.sh` gives every brain every slot in a Latin-square order, because the first pilot ran one brain per slot and its headline gap turned out to be a slot effect.
- **Pre-registration.** Each run folder has a `PREREGISTRATION.md` with the question, the predictions and the reading rule, written before the run. The result is appended after, including the predictions that missed.
- **A stopping rule** where it fits. `compare-sequential.sh` adds passes of 100 rounds per brain and stops by Haybittle-Peto efficacy (|z| >= 3.29), non-binding futility (conditional power under 10%), or two-sided 0.05 at a cap of 400.

Every decision is logged with what the brain saw, the options, the choice and how the round ended (`runLog.ts`). `analyze.ts` turns the logs into a `report.md`: win rates with Wilson intervals, Fisher exact tests, outcomes by slot, route and cue condition, and a per-situation table of what each brain chose. It refuses a run file that holds more than one run. Each run's meta line records the plugin hash, the git commit and a dirty flag. Win rates count draws as non-wins.

### Phase 1: one lane, no lever

The first map, `jev_duel`, is a single 23m lane with one peek spot, so the only real decision is when to peek.

| Run | Rounds per brain | Result |
| --- | --- | --- |
| Pilot, AWP vs AWP, Hard, one brain per slot | 20 | jev 15-5, rush 13-7, rule 7-13, random 7-13 |
| Balanced, AWP vs AWP, Expert | 21 | jev 13-8, rule 12-9, rush 11-10 |
| Lever check, AWP vs AWP | 100 | rush 56%, rule 52% |
| Lever check, AWP vs M4A1, sequential | 100 (futility stop) | rush 56%, rule 55% |
| Lever check, AWP vs M4A1, held zBot | 400 (cap) | rush 54%, rule 48%, z 1.63 |

The pilot looked like a win for Jev, 15-5 against `rule`'s 7-13 (p=0.025). Once every brain played every slot the gap shrank to +4.8 points against `rule` and +9.5 against `rush`, both far from significant. It was mostly a slot effect.

Before spending more API calls, we checked whether this duel had anything to win. Peeking at once (`rush`) and waiting for a cue (`rule`) tied against a pushing AWP zBot, a pushing M4A1 zBot and a held zBot that never advances (`jev_zhold 1`). If the timing of the peek does not decide rounds, a brain that times it better has nothing to gain, so we moved on to a map with a real decision.

### Phase 2: two lanes, a cue to read

`jev_split` has two lanes split by a wall, and a peek spot for each lane that cannot see the other one. Each round the plugin (`jev_zroute`) walks the zBot down a random lane at running speed, then releases it to play on its own. The bot hears which side the footsteps come from, and Jev sees that as `footstepsFrom: left|right`. The brief describes the two lanes but deliberately does not say what footsteps mean, so following them has to come from Jev, not from the instructions.

NOTE: everything in this section was measured after the route fix in `0e7462a`. The first round of two-lane runs used a route that made the zBot snag on the cover crates, see [Earlier results on the snagging route](#earlier-results-on-the-snagging-route).

**The lever is real but small.** Three script-only runs, two passes each at 198 rounds per brain:

| Run | Route seeds | `cuehold` | `sweep` | Other |
| --- | --- | --- | --- | --- |
| Clean lever check | 61 (twice) | 70% | 64% | `cue` 71% |
| `cuewait` check | 71, 72 | 70% | 65% | `cuewait` 69% |
| Jev run | 81, 82 | 67% | 63% | see below |

Over the first two runs (396 rounds per brain) `cuehold` is about 6 points over `sweep` (p 0.11). Reading the cue pays, but much less than the 16 points we saw on the snagging route. `cuewait` tested whether stopping part way out was costing the scripts rounds. It was not: 69% against 70%. The left-route gap that suggested it came from a split I picked after seeing the data, and it did not replicate on fresh seeds.

**Jev against the working zBot.** Pre-registered against `cuehold` (primary: within 5 points means "matches", 5 to 10 is "unresolved") and `sweep` (secondary), on fresh seeds after a 10-round smoke test that Jev won 9-1:

| Brain | Pass 1 | Pass 2 | Combined | Win rate (95% CI) |
| --- | --- | --- | --- | --- |
| `jev` | 73-26 | 76-23 | 149-49 | 75% (69-81) |
| `cuehold` | 65-34 | 67-32 | 132-66 | 67% (60-73) |
| `sweep` | 63-36 | 61-38 | 124-74 | 63% (56-69) |

- Jev against `cuehold`: +8.6 points (CI -0.3 to +17.5, p 0.076). Ahead in both passes, but unresolved by the rule set before the run.
- Jev against `sweep`: +12.6 points (p 0.009).
- Jev picked the correct lane first in 198 of 198 rounds, from a cue its brief never explains.
- All 1,198 requests were live, with no errors, no timeouts and no draws. Median latency was 95ms (p90 142ms), about 6 requests per round.

**Where Jev and `cuehold` differ.** I replayed each of Jev's 1,207 decisions through `cuehold` with the same situation and options. They differ in 41:

| Situation | Jev | `cuehold` | Count |
| --- | --- | --- | --- |
| Scoped, attacker in sight, aim half settled | shoot | wait | 25 |
| Scoped, attacker out of sight | fall back | wait | 8 |
| Scoped, attacker in sight, aim not on him | fall back | wait | 4 |
| Cycling the bolt, aim settling | wait | fall back | 4 |

- **The half-settled shot is Jev's one real edge.** Jev won all 25 rounds where it took one, and 22 of those shots killed within 1.5s. `cuehold` reaches that aim in 42 rounds, shoots in only 6 and wins 86%. That puts the shot at roughly 2 of the 8.6 points. It is a ballpark, not a measurement, because it compares different rounds picked by whether they reached that moment.
- **The other 6 points are not explained.** In 164 of 198 rounds Jev made exactly the choices `cuehold` would have, so that part of the gap is either noise (the interval reaches zero) or timing. Jev acts about 100ms later than the script because of its request latency, and peeks at 0.27s into the round against 0.17s. Whether a later peek helps against a walking zBot was not tested.
- **Jev did not find anything the scripts missed beyond that shot.** Peeking with nothing in sight it counter-strafed in 182 of 182 decisions, like `cuehold`, and `cuewait` already showed the full peek would not have paid.

A run that isolates a 2 to 3 point effect would need thousands of rounds per brain, so we did not run one.

### Earlier results on the snagging route

The first round of two-lane runs used routes at `x=±3.2`. The zBot's hull is about 0.4m either side of its centre and the cover crates start at `x=±3.6`, so it clipped a crate's corner and stopped for good, often out of sight of both peek spots. That turned many rounds into draws and handed out easy kills. Comparisons inside each run stayed fair, because every brain faced the same zBot, but the absolute rates and the size of each lever are not results about a working opponent.

Kept as history:

| Run | Rounds per brain | Result |
| --- | --- | --- |
| `cue` vs `left`, sequential | 100 (efficacy stop) | cue 71%, left 45% |
| `cue` vs `sweep` | 100 | cue 71%, sweep 55% |
| Jev vs `cue` vs `sweep` | 198 | jev 153-42-3 (77%), cue 131-67-0 (66%), sweep 107-67-24 (54%) |
| `cuehold` vs `cue` | 200 | cuehold 71%, cue 66% |

Two findings from these runs still stand as observations, with the caveat above:

- **`cue`'s retreat rule cost it about 5 points.** `cue` inherited `rule`'s scoped retreat, fell back in 131 decisions against Jev's 15, and never won a round after falling back while its aim was settling. Removing that rule is what produced `cuehold`. Jev never needed the rule removed.
- **A noisy cue left nothing to recover.** We corrupted the footsteps label in the sidecar (`cs16/sidecar/src/cueNoise.ts`): hidden or pointing at the wrong lane in some rounds, the same for every brain on a slot. Scripts that trust the label fell 16 to 21 points. None of the cross-checking scripts beat `cuehold` by the 8 points we set as the gate for a Jev run: the 3-second timer gave up on the right lane too early, the 5 and 7-second timers raced the machine's own 5-second fallback (`EXPOSED_MS`), and `cuecheck`, which has no timer, tied `cuehold` at 56%. A parked zBot made a wrong first guess cost a draw rather than a death, which capped what any brain could recover, so this null may not hold on the fixed route.

### Things we got wrong along the way

Each of these was caught in the logs and fixed before the next run. Several would have changed the headline if missed.

- **Slot effect.** The pilot's 40-point gap came from running one brain per server. Fixed with balanced slots.
- **A plugin build without `jev_zhold`.** The hold silently did nothing. `compare.sh` now refuses to start unless the plugin confirms the hold and the enemy weapon.
- **A dirty flag that was always true,** because a tracked benchmark file changed during runs. It now checks code paths only.
- **A zBot spawn out of sight.** One of four spawns sat behind the player's cover crate, so a held zBot never showed up. The spawn row has moved.
- **The bot aimed through walls.** While scoped or cycling it tracked the zBot's live position behind walls. This inflated absolute win rates but did not bias comparisons inside a run, and was fixed before the two-lane runs.
- **A noise roll replayed in every block.** The first noisy-cue run keyed the roll on round number only. It is now keyed on the slot as well.
- **A timer that raced the machine.** The 5-second cross-check's gain was first explained as a recovery window. The logs showed the timer racing the exposure reflex instead.
- **A placeholder navmesh.** `jev_split.nav` was byte-identical to `jev_duel.nav` up to `7285786`. A real mesh (`cs16/learn-nav.sh jev_split`) replaced it, but did not change the parked zBot, so it was not the cause.
- **A route that snagged on the cover crates.** A 1Hz trace of the zBot's distance (`OBS_TRACE`, `cs16/sidecar/src/obsTrace.ts`) showed it stopping at `x=3.2, z=-3.3` on right-route rounds. Moving the routes to `x=±2.8` fixed both lanes: right-route draws fell from 3 of 4 to 1 of 8, and a brain that always peeks left dropped from 9 of 10 left-route wins to 12 of 20. `split.test.ts` now fails any route that comes within a hull width of a crate.
- **One run written twice into the same folder.** Both passes were complete and were split by their meta lines, and `analyze.ts` now refuses such files.
- **A split chosen after seeing the data.** The left-route gap behind `cuewait` did not replicate.

NOTE: the route seed is passed to `compare.sh` but not yet written into the run's meta line, so each run's seed is recorded only in its pre-registration.

### What this proves, and what it doesn't

Proven:

- A ~100ms model can drive a real-time bot when a machine owns what is legal: about 6 decisions per round, no errors over 1,198 live requests, 76 of 96 AWP rounds against the stock zBot.
- Jev reaches the level of the best hand-written cue reader with no rules written for it, on a cue its brief never explains.
- Jev did not pick up the rule that cost `cue` about 5 points on the snagging route, and on the working zBot it takes a half-settled shot the script waits on.

Not proven:

- That Jev beats a well-written script. +8.6 points is unresolved, and only about 2 of them trace to a decision.
- That Jev reads situations rather than labels. The only lever we found is a direct label-to-lane mapping, and a one-line rule captures it.
- Anything about ordinary matches. `jev_split` is a cue task we designed.

Not tested:

- Jev in the rifler's seat.
- Adaptation across rounds. A `jevmem` brain that sees recent rounds exists but never ran in a comparison.
- Jev steering the shipped zBot itself. The design is in [`cs16/STEERING.md`](cs16/STEERING.md) and is not built.

### What's next

The duels so far have too few decisions for a smarter brain to stand out. The ideal next test is an opponent that adapts, because a fixed rule is easy to exploit and reading the situation would actually matter:

- **Humans in the loop.** The browser prototype now keeps a best-of-20 Human vs Jev scoreboard. To turn that into evidence rather than a demo, players would need to face Jev and the best script without knowing which, which is not built yet.
- **If the claim "beats a tuned script" is needed on `jev_split`.** About 450 rounds per brain on fresh seeds, `jev` against `cuehold` and a `cuehold` with a 100ms delay before each move, to separate Jev's decisions from its latency. Roughly 2,700 requests and 4 to 5 hours. Even a clean win would prove a small edge on one map.
- **A cheap check before any Jev run on the noisy cue.** The noisy-cue null was measured on the snagging route. Rerunning `cuehold` against `cuecheck` on the fixed route costs no API calls.

Not worth doing on current evidence: more Jev rounds on `jev_split` without a timing control, or `jevmem`.

Run logs, reports and pre-registrations are written to `cs16/runs/` (gitignored). [`cs16/FINDINGS.md`](cs16/FINDINGS.md) keeps the same results as a running log.

## Two ways to watch it

**Browser prototype** (`pnpm dev`). You play the rifler and Jev is the AWPer, in Three.js, with a best-of-20 scoreboard kept in local storage. It runs the same machine, aim gate and map geometry as the CS sidecar, with CS 1.6 numbers: AK-47 damage and fire rate, GoldSrc movement (221 u/s, `sv_accelerate` 5, `sv_friction` 4) and a 90 degree FOV. `?sens=` sets mouse sensitivity (default 3, the CS default). The deployed build calls Jev through `api/jev.ts`, which keeps the key server-side and falls back to the mock past a per-IP limit or a daily cap (`JEV_DAILY_CAP`, default 2000).

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
  score.ts           Human vs Jev scoreboard for the prototype
src/                 Three.js prototype
api/jev.ts           deployed Jev endpoint: key server-side, rate limit, daily cap
server/jevApi.ts     keeps the API key server-side for the local prototype
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
