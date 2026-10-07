# csgojev

csgojev puts Jev in the AWPer's seat of a Counter-Strike 1.6 duel against the game's own bot (zBot), then measures whether Jev's decisions are what win the rounds. Short answer so far: Jev plays as well as a hand-written script that reads the same cues, but we could not show that it plays better than one.

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

## Does Jev help?

Winning rounds does not mean Jev is the reason. To check, `cs16/compare.sh` keeps everything fixed (map, bot body, machine, zBot) and swaps only the brain that picks the moves. Jev is compared against hand-written scripts in `cs16/sidecar/src/brains.ts` that answer the same question over the same legal moves. Every comparison runs each brain on each server slot, and every run has a pre-registration with the predictions and the reading rule, written before the run started.

What we found:

- **On the original one-lane map (`jev_duel`), there is nothing for a smarter brain to win.** A script that peeks at once (`rush`) and one that waits for a cue (`rule`) tied in three checks of up to 400 rounds each. If the timing of the peek does not decide rounds, better timing has nothing to gain, and in a small balanced run Jev was level with both.
- **On a two-lane map (`jev_split`), Jev matches a script that reads the cue.** The zBot walks down the left or the right lane, and the bot hears which side the footsteps come from (`footstepsFrom`). Over 198 rounds each, Jev won 77%, a hand-written cue reader (`cue`) won 66%, and a script that ignores the cue (`sweep`) won 54%. Jev's first peek went to the right lane every time (0 wrong out of 194), and its brief never says what footsteps mean.
- **About half of Jev's lead over `cue` was a bad rule in `cue`.** `cue` falls back to cover when hurt, and it never won a round where it did that. With only that rule removed (`cuehold`), the script won 71%. The remaining 6 points between Jev and `cuehold` cannot be separated from noise at 200 rounds per brain.
- **A noisy cue hurts the scripts, but there is nothing to recover.** We hid or flipped the footsteps label in some rounds, and the scripts that trust it dropped to about 55%. A script that cross-checks the label (`cuecheck`) peeked both lanes but still tied `cuehold` at 56%, so we did not spend API calls running Jev on it. Part of the reason is the map: after its scripted route the zBot often parks out of sight of both peek spots, so many rounds end in a draw whichever lane you pick.

The claim we can make is that Jev matches a hand-written cue reader on a clean cue, without that rule being written for it. We cannot claim it beats a tuned script on these maps.

| Check | Rounds per brain | Win rate |
| --- | --- | --- |
| One lane, pushing zBot: peek at once vs wait for a cue | 100 | rush 56%, rule 55% |
| One lane, held zBot (`jev_zhold 1`) | 400 | rush 54%, rule 48% |
| Two lanes: Jev vs scripts | 198 | jev 77%, cue 66%, sweep 54% |
| Two lanes: retreat rule removed | 200 | cue 66%, cuehold 71% |
| Two lanes, noisy cue: cross-checking script | 100 | cuehold 56%, cuecheck 56% |

Draws count as non-wins. The full write-up, including the setup bugs we caught and fixed along the way, is in [`cs16/FINDINGS.md`](cs16/FINDINGS.md). Run logs, reports and pre-registrations are written to `cs16/runs/` (gitignored).

What is not tested:

- Jev against the best script at a round count that could see a small edge. Detecting the 6 points above needs about 600 rounds per brain.
- A zBot that keeps coming after its route, so a wrong guess costs a death instead of a draw. That is plugin work, and it is the most direct way to test whether Jev can beat a script.
- Jev steering the shipped zBot itself. The design is in [`cs16/STEERING.md`](cs16/STEERING.md) and is not built.
- Jev in the rifler's seat, and adaptation across rounds. A `jevmem` brain that sees recent rounds exists but was never run in a comparison.
- Ordinary matches. `jev_split` is a cue task we designed (`jev_zroute` drives the zBot down a lane, then releases it), not normal zBot play.

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
