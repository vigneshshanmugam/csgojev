# jev_duel — the duel map

A sealed, aim-map-sized dust2-flavoured lane, transcribed from the Three.js
prototype geometry in `src/game/map.ts`. That file is the level design; nothing
here is invented. `gen.ts` imports `BOXES`, `PLAYER_SPAWN`, `ENEMY_HOLD` and
`ENEMY_PEEK` and converts them, so changing the prototype and rebuilding keeps
the two in sync.

| | metres | units |
| --- | --- | --- |
| spawn to AWPer | 23 | 906 |
| corridor width | 7 | 276 |
| ceiling | 5 | 197 |
| crates | 2.2 | 87 |
| pillar | 3 | 118 |
| eye height | 1.6 | 63 |

906 units is about 3.6 seconds of running at 250 u/s. The crates and the pillar
are all above eye height, so line of sight stays 2D and `blocked()` in the
prototype agrees with what the engine traces.

## Rebuild

```sh
cs16/map/build.sh          # fullbright: CSG + BSP only
cs16/map/build.sh --lit    # full: CSG + BSP + VIS + RAD
```

Output: `cs16/map/out/jev_duel.bsp`. The full compile takes a few seconds on
this map, so there is little reason to use the fullbright path except when
debugging geometry.

The script is idempotent: it clones and builds [sdhlt](https://github.com/seedee/sdhlt)
into `cs16/vendor/` and copies `cs_dust.wad` out of the server image on first
run, then reuses both. Nothing is installed on the host; both the compiler
build and the map compile run in `debian:bookworm-slim`.

Textures are NOT embedded: the BSP stays ~17 KB and references `cs_dust.wad`,
which the web client already has. Embedding (`-nowadtextures`) makes it 340 KB
and the in-browser download stalls at ~30%.

## Run it

```sh
docker create -i --name cs16-map --platform linux/386 \
  -e IP=127.0.0.1 -e PORT=27118 -p 27116:27016 -p 27118:27018/tcp -p 27118:27018/udp \
  ghcr.io/balintsoos/cs16-web-server:latest "+map jev_duel" "+maxplayers 16"
docker cp cs16/map/out/jev_duel.bsp cs16-map:/xashds/cstrike/maps/jev_duel.bsp
docker start cs16-map
docker exec -u 0 cs16-map chmod 777 /xashds/cstrike/maps
```

Copy the BSP in, do not bind-mount it. The server runs as uid 1000 while
`maps/` is owned by uid 999, and it writes `<map>.bsp.ztmp` there when a
browser client connects — a read-only bind mount segfaults it. The `chmod` is
what makes that write succeed.

## Coordinate conversion

1 metre = 39.37 units (1 unit ≈ 1 inch). No translation or rotation offset is
applied beyond the axis relabel, so converting a prototype coordinate is a
single multiply:

| prototype      | GoldSrc |
| -------------- | ------- |
| `x` (lateral)  | `x * 39.37` |
| `z` (downrange)| `y * 39.37` |
| height         | `z * 39.37` |

Useful landmarks:

| | prototype | GoldSrc |
| --- | --- | --- |
| player (CT) spawn | `2.3, 3` | `91, 118` |
| enemy hold | `-2.2, -20` | `-87, -787` |
| enemy peek | `0.9, -20` | `35, -787` |
| eye height | `1.6` | `63` |

## Entities

Four `info_player_start` (CT) at the player end facing downrange, four
`info_player_deathmatch` (T) at the enemy end on the hold and peek spots, and a
row of `light` entities under the ceiling.

The CT row starts at the first x where a whole player hull is in view of the
enemy peek spot (45 units), not at the prototype player spawn (91 units). That
spawn is behind the player-cover crate, so a zBot held there with `jev_zhold` was
never seen and its rounds ran out as draws (one round in four).

No buy zones, no objectives — weapons are given programmatically by the plugin.
