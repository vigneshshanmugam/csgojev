#!/usr/bin/env bash
# Sequential two-brain comparison: balanced passes (compare-balanced.sh), a
# look after each, stop by the pre-registered rule in analyze.ts
# (sequentialLook: Haybittle-Peto efficacy at |z| >= 3.29, non-binding futility
# below 10% conditional power, two-sided 0.05 at the cap).
#
#   cs16/compare-sequential.sh <brainA> <brainB> [per look] [cap] [slots]
#   ENEMY_WEAPON=weapon_m4a1 DIFFICULTY=3 cs16/compare-sequential.sh rush rule 100 400 "3 4 6 7"
#
# "per look" is rounds per brain added by each pass; it must divide by the slot count.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
A=$1
B=$2
PER_LOOK=${3:-100}
CAP=${4:-400}
SLOTS=${5:-3 4 6 7}
read -r -a slot_list <<< "$SLOTS"
BLOCK=$((PER_LOOK / ${#slot_list[@]}))
if [ $((BLOCK * ${#slot_list[@]})) -ne "$PER_LOOK" ]; then
  echo "compare-sequential: per look ($PER_LOOK) must divide by the slot count (${#slot_list[@]})" >&2; exit 1
fi
OUT="${RUN_DIR:-$HERE/runs/$(date +%Y%m%d-%H%M%S)-seq-$A-$B}"
mkdir -p "$OUT"
analyze() { (cd "$ROOT" && "$ROOT/node_modules/.bin/tsx" cs16/sidecar/src/analyze.ts "$@"); }

passes=$((CAP / PER_LOOK))
for k in $(seq 1 "$passes"); do
  RUN_DIR="$OUT/pass$k" "$HERE/compare-balanced.sh" "$BLOCK" "$A $B" "$SLOTS"
  verdict=$(analyze "$OUT"/pass* "--look=$A,$B,$CAP")
  echo "compare-sequential: after pass $k: $verdict" | tee -a "$OUT/looks.txt"
  case "$verdict" in
    *continue*) ;;
    *) break ;;
  esac
done
analyze "$OUT"/pass* > "$OUT/report.md"
echo "compare-sequential: report in $OUT/report.md"
