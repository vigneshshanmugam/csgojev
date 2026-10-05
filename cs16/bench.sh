#!/usr/bin/env bash
# Jev (AWP) vs zBot (same weapon) across difficulties and plugin settings.
#
#   cs16/bench.sh [rounds] [difficulties] [preaim values]
#   cs16/bench.sh 16 "0 1 2 3" "0 1"
#
# Boots once, then for every (difficulty, preaim) re-adds the zBot, applies the
# setting with jev_tune and runs N rounds. Needs `pnpm sidecar` running on the
# same SLOT (see slot.sh). Appends one TSV line per cell to cs16/bench-results.tsv.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/slot.sh"
ROUNDS=${1:-16}
DIFFS=${2:-"0 1 2 3"}
PREAIMS=${3:-"0 1"}
WEAPON=${WEAPON:-weapon_awp}  # applied to BOTH Jev's bot and the zBot
TURN=${TURN:-220}
OUT=${OUT:-$HERE/bench-results.tsv}
LOG="/tmp/$NAME.console"

say() { "$HERE/run.sh" say "$1"; sleep "${2:-2}"; }
clean() { sed 's/\x1b\[[0-9;]*m//g' "$LOG"; }
count() { clean | grep -c "$1" || true; }

"$HERE/run.sh"
sleep 25
say "map jev_duel" 0
for _ in $(seq 1 45); do [ "$(count 'player server started')" -ge 2 ] && break; sleep 2; done
for c in "log off" "mp_freezetime 0" "mp_timelimit 0" "bot_quota 0" "jev_spawn 1"; do say "$c"; done
sleep 8
say "jev_bridge $BRIDGE_HOST $OBS"
say "jev_weapon $WEAPON"

[ -f "$OUT" ] || printf 'time\tweapon\tdifficulty\tpreaim\tturn\trounds\twins\tlosses\tdraws\tavg_win_s\n' > "$OUT"

for d in $DIFFS; do
  for p in $PREAIMS; do
    say "bot_kick" 3
    say "bot_difficulty $d"
    say "bot_add_ct" 8
    say "jev_tune $TURN 1 $p"
    say "jev_burst ${BURST:-0.45}"
    before=$(count 'duel over')
    say "jev_duel $ROUNDS" 0
    for _ in $(seq 1 $((ROUNDS * 12))); do
      [ "$(count 'duel over')" -gt "$before" ] && break
      sleep 5
    done
    line=$(clean | grep 'duel over' | tail -1)
    w=$(sed -n 's/.* \([0-9]*\) wins.*/\1/p' <<<"$line")
    l=$(sed -n 's/.* \([0-9]*\) losses.*/\1/p' <<<"$line")
    dr=$(sed -n 's/.* \([0-9]*\) draws.*/\1/p' <<<"$line")
    avg=$(clean | grep -E 'round [0-9]+ win after' | tail -n "${w:-1}" | sed -n 's/.*after \([0-9.]*\)s.*/\1/p' \
      | awk '{s+=$1;n++} END {if(n) printf "%.1f", s/n; else print "-"}')
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date +%H:%M:%S)" "${LABEL:-$WEAPON}" "$d" "$p" "$TURN" \
      "$ROUNDS" "${w:-?}" "${l:-?}" "${dr:-?}" "$avg" | tee -a "$OUT"
  done
done
echo "done: $OUT"
