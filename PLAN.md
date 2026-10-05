# PLAN: Jev bot vs zBot, 1v1, in real CS 1.6

## Intent

Put Jev (TypeSafe System One) in charge of a bot inside a real Counter-Strike 1.6
server, and duel it against the game's own bot on a tiny purpose-built map.

- **The match:** 1v1, Jev-controlled bot vs stock zBot on Easy, on a very small
  dust2-flavoured map. Headless and repeatable: run N rounds, report win rate.
  Humans, teams and the browser client come later.
- **Jev's job:** tactical decisions only (peek, counter-strafe, shoot, fall back).
  An XState machine defines what is physically legal; Jev only picks among events
  the machine accepts. It never aims, never moves, never writes actions.
- **Engine's job:** everything fast. Movement, aim, bullets, hit resolution and
  line of sight all happen in GoldSrc at 100 tick. Jev is a ~100ms brain on top.
- **Why 1v1 vs zBot:** zBot is a free, hand-written baseline that nobody can
  accuse of being tuned for us. Same map, same weapon, same spawns, measured win
  rate. That is the experiment; everything else is scaffolding.
- **Non-goals (for now):** humans in the loop, teams, bomb/hostage objectives,
  multiple lanes, map generality, pretty visuals.

The Three.js prototype in `src/` stays as the validated reference implementation.
Its machine, its duel geometry and its headless sim all port across; see §5.

---

## Status: all three parts exist and work in isolation. Our bot has a body and
fights; a zBot opposes it; the map compiles; the brain runs at ~95ms. The only
remaining work is wiring the plugin to the sidecar's UDP ports.

## 0. Ground truth (verified, not assumed)

Facts established by actually running things. These cost real time to find, so
they are written down.

1. **The server works.** `ghcr.io/balintsoos/cs16-web-server:latest` runs a CS 1.6
   dedicated server plus a browser client, on arm64 via `--platform linux/386`.
   Serves at :27016, WebRTC on :27018.
2. **No Steam purchase needed.** Game content is baked into the image, sourced
   from SteamCMD app 90 (the free HLDS download). `cstrike/` and `valve/` with 25
   stock maps are present.
3. **Metamod-r crashes this engine; metamod-p works.** metamod-r loads, prints its
   banner, then segfaults during API acquisition — it scans for ReHLDS engine
   signatures and this is a Go/CGO-wrapped Xash3D. metamod-p hooks via plain
   function pointers and works first try. Note this contradicts both the upstream
   FWGS advice in FWGS/xash3d-fwgs#2180 and the image's own README.
4. **Fake clients work.** `pfnCreateFakeClient` returns a client the engine lists
   as type `Bot`, and the server survives `pfnRunPlayerMove` every frame.
5. **zBot is in the stock `cs.so`** — `bot_add`, `BotProfileManager`,
   `bot_difficulty`, `bot_stop`, `bot_zombie`, `bot_goto_mark`.
6. **zBot generates its own navmesh.** `GenerateNavigationAreaMesh`,
   `ConnectGeneratedAreas`, `MergeGeneratedAreas`, `m_isLearningMap` and the
   `#CZero_AnalyzingHidingSpots` strings are all compiled in. No `.nav` sourcing.
7. **`BotProfile.db` is missing and is not in any open-source release.** It is a
   retail client file. We author our own — the format is plain text parsed by
   `bot_profile.cpp`, and writing it ourselves makes the Easy opponent exactly
   specified and reproducible.
8. **`bot_zombie` is a global cvar**, so it cannot be used to neutralise one bot
   in a bot-vs-bot match. Jev's bot must therefore be our own fake client, not a
   hijacked zBot.
9. **Server console** is reachable by running the container with `-i` and feeding
   `docker attach` through a FIFO. There is no A2S responder.
10. **Custom maps: `docker cp` them in, do not bind-mount them.** A read-only
    single-file bind mount boots but crashes the server the moment a browser client
    connects: it writes `<map>.bsp.ztmp` beside the map for web delivery, gets
    `Permission denied`, and segfaults. Copy the file in and `chown 999:999` it.
11. **The WebRTC port must match inside and out, and be unique per server.** The
    server binds to the `PORT` env value *inside* the container, so publish
    `-p $PORT:$PORT`, never `-p <other>:27018`. HTTP is always container-side 27016
    and may be remapped freely. The client is handed the address literally — its
    `start()` runs `connect 127.0.0.1:8080` through a WebRTC shim fed by `IP`/`PORT`
    — so two servers sharing a `PORT` will send browsers to the same one whatever
    HTTP port they loaded from. A mismatch loads the page fine and silently never
    connects, which looks like a broken map.
12. **Dust textures are in `cs_dust.wad`, not `cstrike.wad`.** Do NOT embed them
    (`-nowadtextures`): the BSP grows 17 KB -> 340 KB and the browser's netchan
    download stalls at ~30%. The web client already ships `cs_dust.wad`, so the
    17 KB BSP loads textures from it.
19. **`TRACE_LINE` does not hit fake-client hitboxes.** An aim ray passes straight
    through a standing zBot, so `CrosshairOn` tests the enemy's bounding box
    analytically and uses the world trace only for the occluder. Without this
    `onTarget` stays 0 and Jev never fires (0 shots in 3 rounds before the fix).
20. **Nav must be `cstrike/maps/<map>.nav`, mode 644.** Learned navs land in
    `czero/maps/` (spoofed gamedir) but the loader reads via the engine FS, i.e.
    `cstrike/maps/`; 0640 gives `Permission denied` -> "Failed to load navigation
    map". `cs16/run.sh` does this; `cs16/duel.sh [n]` runs the whole match.
21. **Waypoints come from `src/game/map.ts`** via `plugin/geom.sh` -> `mapgeom.h`;
    rebuild the plugin with `cs16/plugin/build.sh` after changing the map.
13. **The metre scale is confirmed.** 39.37 units/metre maps the prototype's
    `EYE = 1.6` onto 63 units against CS's standing eye of ~64. World coordinates
    are `proto.x -> x`, `proto.z -> y`, height -> `z`, times 39.37, no offsets.
14. **zBot only exists if the game directory is `czero`.** The stock `cs.so` gates
    `UTIL_AreBotsAllowed()` on the gamedir, and `Bot_RegisterCVars` returns early
    otherwise — so on a `cstrike` dedicated server `bot_add` and every `bot_*` cvar
    simply do not exist, with no error. Fixed inside our plugin by hooking
    `pfnGetGameDir` and reporting `"czero"` to the game DLL only; the engine's file
    system is untouched. Cost: two CZ player models (`spetsnaz`, `militia`) fail to
    precache, so profiles pin skins to 1-4.
15. **The navmesh generates itself, once.** `bot_add` on a map with no `.nav` starts
    the learn process (`CCSBot::SpawnBot` sees an empty area list). It took ~15min
    under QEMU and saves via `GET_GAME_DIR`, so with the spoof active it lands in
    `czero/maps/` — and `SaveNavigationMap` does NOT mkdir, so pre-create it. The
    result is cached at `cs16/gamedata/maps/de_dust2.nav` and mounted read-only.
16. **`BotProfile.db` needs named profiles, not just a template.** A profile's first
    token must be a template reference list, so `Template Easy` alone is not
    loadable. Ours is at `cs16/gamedata/BotProfile.db`.
17. **Drive the console with logging OFF.** `log on` makes the game DLL call
    `engine:IsCareerMatch`, which this engine lacks, so metamod prints a warning per
    log line and floods the console. The log *file* is clean.
18. **Jev's distance bucket and the world-sync dedup divisors must agree.** `metres()`
    buckets distance for Jev's context; three separate places dedupe world syncs by
    rounding distance (`engine.ts`, `scripts/duel.ts`, `cs16/sidecar/src/bot.ts`). If
    any of them rounds *coarser* than `metres()` reads, a change Jev would have acted
    on never reaches it. All four are on `/2` now (tightened from 5m when the lane
    shrank to 23m, to keep ~12 distinct readings across the approach).
19. **An event the machine ignores still wakes the Jev agent.** Feeding a repeated
    world event at 20Hz keeps resetting the 120ms settle window, and the bot stops
    deciding for seconds at a time. Send world events to the machine on edges only.
    This is a general `@xstate/jev` lesson, not a CS one. Pinned by a regression test
    in `cs16/sidecar/src/bot.test.ts`.

## 1. What exists

```
cs16/
  overlay/      mounted over /xashds/cstrike: liblist.gam + addons/
  plugin/       jevbot.cpp, h_export.cpp, Makefile  (builds in i386/debian)
  gamedata/     BotProfile.db + cached maps/de_dust2.nav
  map/          gen.ts, build.sh, jev_duel.map, out/jev_duel.bsp
  sidecar/      the brain: protocol.ts, bot.ts, sidecar.ts, fakePlugin.ts
  vendor/       metamod-p, metamod-r, ReGameDLL, sdhlt, WADs (gitignored)
```

`jevbot` builds with one `docker run` against `i386/debian:bookworm-slim`. The
overlay mounts into the stock image, so the upstream container is never rebuilt
or forked. The sidecar is part of the root package: `pnpm sidecar`, `pnpm duel:cs`.

## 2. Build order

Ordered by risk, not by how it will read in a demo. Steps 1–3 need no map, so the
mechanical unknowns get settled on de_dust2 before any level design happens.

**1. Give the fake client a body. DONE.** `FakeClientCommand` is implemented the
POD-Bot way: fill a synthetic argv, raise a flag, call `MDLL_ClientCommand`, and
supercede `pfnCmd_Args`/`Argv`/`Argc` through `GetEngineFunctions` while the flag is
set. `jev_spawn <team>` then issues `jointeam` / `joinclass` and arms the bot. Note
`GiveNamedItem` is NOT reachable from a plugin — spawn the weapon entity and call
`MDLL_Touch` against the bot instead. CS strips weapons between rounds, so the bot
re-arms on respawn. Verified: `model=urban`, `health=100`, `solid=3`, `movetype=3`,
`weaponmodel=models/p_awp.mdl`, and the origin moves under `pfnRunPlayerMove`.

**2. Make zBot run. DONE.** Needed the `czero` gamedir spoof (§0.14) before any
bot cvar existed at all. With that plus our authored `BotProfile.db` and the cached
navmesh, `bot_difficulty 0` + `bot_add` produces a working Easy zBot that plays
de_dust2 properly — it takes the bomb, walks to a site and plants it, which is the
real proof the generated nav is sound.

**3. Put both in one server. DONE.** Verified from the server log: kills in both
directions, AWP damage landing, rounds resolving. Final scoreboard `JevBot 2`,
`Hollis 10` — the zBot wins comfortably, which is the honest baseline we want to
beat. Our bot's combat here is placeholder engine-side aiming, to be replaced by
machine-driven behaviour in step 5.

**4. The map. DONE, and since shrunk to aim-map scale.** `cs16/map/gen.ts` imports
the geometry from `src/game/map.ts` and emits the `.map`, so the prototype stays the
single source of level design. `cs16/map/build.sh --lit` compiles leak-free in ~4s.

The first cut was 2677 units long and 394 wide — an avenue, confirmed by walking it.
Now:

| | metres | units |
| --- | --- | --- |
| spawn -> AWPer | 23 | 906 (3.6s run) |
| corridor width | 7 | 276 |
| ceiling | 5 | 197 |
| crates / pillar | 2.2 / 3 | 87 / 118 |

**The shrink made the duel better, not just faster.** A/B'd against a scripted rifler:
on the old lane a bot that peeked and stayed out died **100%** of the time, so the only
survivable play was never being seen. On the new one the same bot lives 42-74%, so
managing exposure has a gradient instead of being pass/fail. The swing also became
physically plausible: hold->peek is now 3.1m over `PEEK_MS`, i.e. 5.6 m/s, where the
old geometry demanded 8 m/s — faster than a player can strafe.

Waypoints for the plugin (times 39.37): `PLAYER_SPAWN` `91, 118`,
`ENEMY_HOLD` `-87, -787`, `ENEMY_PEEK` `35, -787`.

Retuned with it: `ROUND_SECONDS` 95 -> 45, fog 85/220 -> 30/80, footstep range 35m ->
12m, rifler range falloff and the scripted routes rescaled, and the renderer floor now
derives from the `BOXES` bounds so it cannot drift out from under the walls on the next
scale change.

**5. The bridge. DONE.** `cs16/sidecar/` owns the brain. `pnpm sidecar` listens for
perception on 27100 and emits intents on 27101; `pnpm duel:cs <n> [route]` runs n
rounds end to end against a fake plugin with no engine at all. `protocol.ts` is the
single definition of the wire (zod schemas, newline framing, malformed lines dropped
rather than thrown). The plugin sends `atWaypoint` and `weaponReady` as plain level
values at 20Hz — the sidecar derives the edges itself, so the plugin needs no latching.
Perception must only contain what a player could sense: `TraceLine` eye-to-eye for
sight, distance and speed for footsteps, `sinceSeen` tracked server-side.

**The aim gate.** Live play showed the bot burning its first AWP shot every round at
~6% hit chance: the `shoot` guard only checked `playerVisible`, so firing was legal
the instant the bot stopped, before the scope settled — and Jev correctly took the
only aggressive option on the menu. Fixed in the machine, where it belongs, as a
second condition: `playerVisible && onTarget >= aimSeconds`. This added a required
`onTarget` field (seconds, float, continuous time the crosshair has been on the
enemy, zeroed the moment that breaks) to the `obs` packet. **A plugin that omits it
will never fire.** Jev is also shown a four-bucket aim cue, because once the shot is
withheld, "fall back" and "wait" are indistinguishable unless it knows whether a shot
is one beat away. Measured: rusher 1/5 -> 4/5, jiggler 3/5 -> 4/5, worst shot taken
p=0.02 -> p=0.64. `--no-aim-gate` reproduces the old behaviour.

**6. Port the machine. DONE.** Parameterised, not forked: `createEnemyMachine(client,
timing?)` takes optional `{ peekMs, boltMs }`, and the machine gained `world.arrived`
and `world.weaponReady`, which the prototype simply never sends. `src/` is unchanged in
behaviour and its tests pass untouched. `peeking` exits on arrival and `cycling` on the
weapon; both timers are demoted to safety nets (2s / 2.5s). `EXPOSED_MS` is untouched.

**Live result:** 3/3 rounds won against a scripted rusher, median decision latency
**96ms**, max 277ms over 18 live requests (12 acted on, 6 deliberate waits).

**7. The harness.** `mp_freezetime`, `sv_restartround`, plugin logs each round
outcome, a script aggregates N rounds into a win rate plus Jev latency and decision
counts. This is the `/eval` item the old plan wanted, with a real engine under it.

## 3. Definition of done (v1)

- [ ] Jev's bot spawns with an AWP and moves under machine control.
- [ ] A zBot on Easy spawns and fights it.
- [ ] Both duel on the small map, round after round, without manual intervention.
- [ ] `pnpm duel:cs <n>` reports win rate over n rounds.
- [ ] Decision log per round: state, options offered, confidence, latency.

## 4. Known risks

- **Team join.** The one remaining mechanical unknown (step 1). Well-trodden in
  POD-Bot, but unproven on this engine.
- **sdhlt on i386.** Build and WAD path handling untested.
- **Map learning on a tiny map.** The nav generator may behave oddly on a space
  with almost no areas.
- **Fairness tuning.** Turn rate and acquire time decide whether the bot reads as
  human or as a turret. Unlike the Three.js version these now drive real bullets
  through real hitboxes, so they must be tuned against actual outcomes.
- **Escape hatch.** If metamod-p ever fails us, `hlds_linux` and `engine_i486.so`
  are both inside the image — develop against real HLDS, lose only the browser.

## 5. Porting the machine

`src/game/enemyMachine.ts` imports only `xstate`, `zod` and `@xstate/jev`, so it
moves into the sidecar nearly unchanged. `EnemyContext` is already perception-
shaped. What changes is that the machine currently *simulates* timings the real
engine will own:

- `after: { [PEEK_MS] }` assumes the renderer lerps the bot over exactly 550ms. In
  CS the bot walks and arrival varies — exit `peeking` on an arrival event from the
  plugin, keep the timer as a safety net.
- `BOLT_MS` is enforced by the real weapon, so `cycling` should follow weapon state.
- `EXPOSED_MS` stays. It is a behavioural reflex, not simulated physics.
- Death, damage and round transitions arrive from Metamod hooks instead of the game loop.

`combat.ts` mostly retires: the engine traces real bullets, so `awpHitChance()` is
replaced by actual aim quality (turn rate, acquire time). That is an upgrade — the
bot shoots through the same hitboxes its opponent does, so the result is honest.

The `ROUTES` waypoints in `scripts/duel.ts` become the bot's movement targets. This
is why the navmesh never mattered for our bot: waypoints, not pathfinding.

## 6. Later

- Humans: the browser client already works, so a human can simply take a slot.
- Swap sides — Jev rifles, zBot AWPs — the honest test of whether the architecture
  generalises or whether one duel got hand-tuned.
- More waypoints so Jev picks among peek lines, instead of two fixed spots.
- A hand-written decision-tree bot as a third contestant, same legal events.
- Fork ReGameDLL_CS if map-general behaviour is ever wanted: it carries the full
  zBot source, including its own `simple_state_machine.h`.

## 7. Notes

- Key stays server-side (`server/jevApi.ts`); mock Jev when `TYPESAFE_API_KEY` unset.
- Jev = slow tactical brain (~100ms measured), engine = fast physics. Keep the split.
- `server/jevApi.ts` is a Vite `configureServer` middleware, so `/api/jev` exists in
  `pnpm dev` but not in a built `dist/`. Needs porting before anything is deployed.
