#!/usr/bin/env bash
# Balanced brain comparison: one server per slot in parallel, each running
# every brain in a rotated order (a Latin square). Every brain gets every slot
# and every time position once, so neither a slow server nor a bad stretch of
# time can favour one brain.
#
#   cs16/compare-balanced.sh [rounds per block] [brains] [slots]
#   DIFFICULTY=3 cs16/compare-balanced.sh 7 "jev rush rule" "3 4 6"
#
# Rounds per brain = rounds per block x number of slots. More slots than brains
# (a multiple) repeat the rotation: "rush rule" on "3 4 6 7" is AB, BA, AB, BA.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BLOCK=${1:-7}
read -r -a BRAINS <<< "${2:-jev rush rule}"
read -r -a SLOTS <<< "${3:-3 4 6}"
if [ $(( ${#SLOTS[@]} % ${#BRAINS[@]} )) -ne 0 ]; then
  echo "compare-balanced: the slot count must be a multiple of the brain count (${#BRAINS[@]})" >&2; exit 1
fi
export RUN_DIR="${RUN_DIR:-$HERE/runs/$(date +%Y%m%d-%H%M%S)-balanced}"
mkdir -p "$RUN_DIR"
echo "compare-balanced: ${BRAINS[*]} on slots ${SLOTS[*]}, $BLOCK rounds per block, logs in $RUN_DIR"

pids=()
n=${#BRAINS[@]}
for i in "${!SLOTS[@]}"; do
  order=()
  for j in $(seq 0 $((n - 1))); do order+=("${BRAINS[$(((i + j) % n))]}"); done
  echo "compare-balanced: slot ${SLOTS[$i]} runs ${order[*]}"
  SLOT=${SLOTS[$i]} "$HERE/compare.sh" "$BLOCK" "${order[*]}" > "$RUN_DIR/slot${SLOTS[$i]}.out" 2>&1 &
  pids+=($!)
  # Staggered starts: Docker Desktop's UDP forwarding is flakiest under simultaneous recreates.
  sleep 20
done

failed=0
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    echo "compare-balanced: slot ${SLOTS[$i]} failed, see $RUN_DIR/slot${SLOTS[$i]}.out" >&2
    failed=1
  fi
done
(cd "$ROOT" && "$ROOT/node_modules/.bin/tsx" cs16/sidecar/src/analyze.ts "$RUN_DIR") > "$RUN_DIR/report.md"
echo "compare-balanced: report in $RUN_DIR/report.md"
exit $failed
