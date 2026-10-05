#!/usr/bin/env bash
# Brain comparison: the same server, body (body.env) and opponent, one run per
# brain, every decision and round outcome logged, then the statistics.
#
#   cs16/compare.sh [rounds] [brains]
#   cs16/compare.sh 50 "jev rule random"
#   RUN_DIR=cs16/runs/x SLOT=4 cs16/compare.sh 50 rule   # one brain per slot, in parallel
#
# Starts its own sidecar per brain, so do not run `pnpm sidecar` on this slot.
# Defaults to SLOT=3 to stay clear of servers people play on. Jev needs
# TYPESAFE_API_KEY (in .env); a Jev run without it refuses to start.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
export SLOT=${SLOT:-3}
. "$HERE/slot.sh"
. "$HERE/body.env"
# ZHOLD=1 pins the zBot where it stands (it still aims and fires): an opponent
# that holds an angle instead of pushing.
ZHOLD=${ZHOLD:-0}
ROUNDS=${1:-50}
BRAINS=${2:-"jev rule random"}
# Set RUN_DIR to share one directory between slots running brains in parallel.
RUN_DIR="${RUN_DIR:-$HERE/runs/$(date +%Y%m%d-%H%M%S)}"
LOG="/tmp/$NAME.console"
mkdir -p "$RUN_DIR"

say() { "$HERE/run.sh" say "$1"; sleep "${2:-2}"; }
count() { sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -c "$1" || true; }
stop_sidecar() {
  [ -n "${SIDECAR_PID:-}" ] && kill "$SIDECAR_PID" 2>/dev/null || true
  for pid in $(lsof -nP -iUDP:"$OBS" -t 2>/dev/null); do
    ps -p "$pid" -o comm= | grep -q node && kill "$pid" 2>/dev/null || true
  done
  SIDECAR_PID=
}
trap stop_sidecar EXIT

PLUGIN_SHA=$(shasum "$HERE/overlay/addons/jevbot/jevbot_mm_i386.so" | cut -c1-12)
GIT_SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo none)
META=$(printf '{"rounds":%s,"weapon":"%s","turn":%s,"scope":%s,"preaim":%s,"difficulty":%s,"zhold":%s,"plugin":"%s","git":"%s"}' \
  "$ROUNDS" "$WEAPON" "$TURN" "$SCOPE" "$PREAIM" "$DIFFICULTY" "$ZHOLD" "$PLUGIN_SHA" "$GIT_SHA")

"$HERE/run.sh"
sleep 25
say "map jev_duel" 0
for _ in $(seq 1 45); do [ "$(count 'player server started')" -ge 2 ] && break; sleep 2; done
for c in "log off" "mp_freezetime 0" "mp_timelimit 0" "bot_quota 0" "jev_spawn 1"; do say "$c"; done
sleep 8
say "jev_weapon $WEAPON"
say "jev_tune $TURN $SCOPE $PREAIM"
say "bot_difficulty $DIFFICULTY"
if [ "$ZHOLD" != 0 ]; then
  say "jev_zhold $ZHOLD"
  if [ "$(count 'zhold=1')" -eq 0 ]; then
    echo "compare: ZHOLD=1 but the plugin did not confirm it (built without jev_zhold?)" >&2; exit 1
  fi
fi

for brain in $BRAINS; do
  stop_sidecar
  (cd "$ROOT" && BRAIN="$brain" RUN_LOG="$RUN_DIR/$brain.jsonl" RUN_META="$META" \
    exec "$ROOT/node_modules/.bin/tsx" cs16/sidecar/src/main.ts) > "$RUN_DIR/$brain.sidecar.log" 2>&1 &
  SIDECAR_PID=$!
  for _ in $(seq 1 30); do grep -q 'listening' "$RUN_DIR/$brain.sidecar.log" 2>/dev/null && break; sleep 1; done
  if ! grep -q 'listening' "$RUN_DIR/$brain.sidecar.log"; then
    echo "compare: $brain sidecar did not start:" >&2; cat "$RUN_DIR/$brain.sidecar.log" >&2; exit 1
  fi

  say "jev_bridge $BRIDGE_HOST $OBS"
  say "bot_kick" 3
  say "bot_add_ct" 8
  before=$(count 'duel over')
  say "jev_duel $ROUNDS" 0
  echo "compare: $brain, $ROUNDS rounds vs difficulty $DIFFICULTY"
  for _ in $(seq 1 $((ROUNDS * 12))); do
    [ "$(count 'duel over')" -gt "$before" ] && break
    if [ "$(count 'Crash:')" -gt 0 ]; then echo "compare: server crashed during $brain" >&2; exit 1; fi
    sleep 5
  done
  sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep 'duel over' | tail -1
done
stop_sidecar

(cd "$ROOT" && "$ROOT/node_modules/.bin/tsx" cs16/sidecar/src/analyze.ts "$RUN_DIR") | tee "$RUN_DIR/report.md"
echo "compare: logs and report in $RUN_DIR"
