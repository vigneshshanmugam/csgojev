#!/usr/bin/env bash
# Fresh Jev server: stock image + metamod overlay + plugin, small map copied in.
#
#   cs16/run.sh              # container cs16-jev, HTTP :27036, WebRTC :27038
#   cs16/run.sh say "cmd"    # send one server-console command
#   SLOT=1 cs16/run.sh       # a second, isolated server (see slot.sh)
#   ADDONS=/dir cs16/run.sh  # mount another addons dir (a plugin build under test)
#
# The map is docker-cp'd, never bind-mounted (README gotcha 8). The console is a FIFO
# fed to `docker attach` (README gotcha 11); it must stay open or the engine sees EOF.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/slot.sh"
IMAGE="ghcr.io/balintsoos/cs16-web-server:latest"
FIFO="/tmp/$NAME.in"

if [ "${1:-}" = "say" ]; then
  echo "$2" > "$FIFO"
  exit 0
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
# Docker Desktop releases the old UDP forward asynchronously; starting the new
# container while it is still held leaves the new one with no host forward.
if command -v lsof >/dev/null; then
  for _ in $(seq 1 15); do
    [ -z "$(lsof -nP -iUDP:"$PORT" -t 2>/dev/null)" ] && break
    sleep 1
  done
fi
pkill -f "tail -f $FIFO" 2>/dev/null || true
rm -f "$FIFO"; mkfifo "$FIFO"
mkdir -p "$HERE/logs/$NAME"

docker run -d -i --name "$NAME" --platform linux/386 \
  -e IP=127.0.0.1 -e PORT="$PORT" \
  -p "$HTTP":27016 -p "$PORT":"$PORT"/tcp -p "$PORT":"$PORT"/udp -p 127.0.0.1:"$INTENT":27101/udp \
  -v "$HERE/logs/$NAME":/xashds/cstrike/logs \
  -v "${ADDONS:-$HERE/overlay/addons}":/xashds/cstrike/addons \
  -v "$HERE/overlay/liblist.gam":/xashds/cstrike/liblist.gam:ro \
  -v "$HERE/gamedata/BotProfile.db":/xashds/cstrike/BotProfile.db:ro \
  "$IMAGE" "+map de_dust2" "+maxplayers 16" >/dev/null

python3 - "$FIFO" "$NAME" <<'PY'
import subprocess, sys
fifo, name = sys.argv[1:3]
subprocess.Popen(["sh", "-c", f"tail -f {fifo} | docker attach --sig-proxy=false {name}"],
                 stdout=open(f"/tmp/{name}.console", "w"), stderr=subprocess.STDOUT,
                 stdin=subprocess.DEVNULL, start_new_session=True)
PY

# Server runs as uid 1000 and writes <map>.bsp.ztmp here when a browser joins;
# without write access it segfaults (README gotcha 8). zBot nav save uses
# czero/maps because the plugin spoofs the game directory to unlock bots.
docker exec -u 0 "$NAME" sh -c 'mkdir -p /xashds/czero/maps; chmod 777 /xashds/cstrike/maps /xashds/czero/maps'

for bsp in "$HERE"/map/out/jev_*.bsp; do
  [ -f "$bsp" ] || continue
  docker cp "$bsp" "$NAME":/xashds/cstrike/maps/"$(basename "$bsp")"
  docker cp "$bsp" "$NAME":/xashds/czero/maps/"$(basename "$bsp")"
  docker exec -u 0 "$NAME" chown 999:999 /xashds/cstrike/maps/"$(basename "$bsp")"
  docker exec -u 0 "$NAME" chown 999:999 /xashds/czero/maps/"$(basename "$bsp")"
done
# Cached navmesh (learned once; README gotcha 4). Must be world-readable, in cstrike/maps.
for nav in "$HERE"/gamedata/maps/jev_*.nav; do
  [ -f "$nav" ] || continue
  docker cp "$nav" "$NAME":/xashds/cstrike/maps/"$(basename "$nav")"
  docker cp "$nav" "$NAME":/xashds/czero/maps/"$(basename "$nav")"
  docker exec -u 0 "$NAME" sh -c "chown 999:999 /xashds/cstrike/maps/$(basename "$nav"); chmod 644 /xashds/cstrike/maps/$(basename "$nav")"
  docker exec -u 0 "$NAME" sh -c "chown 999:999 /xashds/czero/maps/$(basename "$nav"); chmod 644 /xashds/czero/maps/$(basename "$nav")"
done
# Docker Desktop sometimes skips the host-side UDP forward when a container is
# recreated on the same ports. The page then loads but WebRTC never connects and
# the client hangs on "Loading cached game files..." with no error.
if command -v lsof >/dev/null; then
  for _ in $(seq 1 15); do
    [ -n "$(lsof -nP -iUDP:"$PORT" -t 2>/dev/null)" ] && break
    sleep 1
  done
  if [ -z "$(lsof -nP -iUDP:"$PORT" -t 2>/dev/null)" ]; then
    echo "run.sh: no host UDP listener on :$PORT; browsers cannot connect. Re-run cs16/run.sh." >&2
    exit 1
  fi
fi
echo "up: $NAME http://localhost:$HTTP  console: SLOT=$SLOT cs16/run.sh say '<cmd>'  sidecar: SLOT=$SLOT pnpm sidecar"
