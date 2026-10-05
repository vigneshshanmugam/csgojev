#!/usr/bin/env bash
# Fresh server -> jev_duel map -> Jev bot (T), then one of:
#   cs16/duel.sh bots [rounds] [difficulty]
#                                zBot (CT), N scored rounds (default 10);
#                                difficulty 0 easy, 1 normal, 2 hard, 3 expert
#   cs16/duel.sh human           no zBot; join from the browser as CT and play
# Needs `pnpm sidecar` running on the host, on the same SLOT (see slot.sh).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/slot.sh"
MODE=${1:-bots}
say() { "$HERE/run.sh" say "$1"; sleep "${2:-2}"; }
loads() { sed 's/\x1b\[[0-9;]*m//g' "/tmp/$NAME.console" | grep -c 'player server started' || true; }

case "$MODE" in bots|human) ;; *) echo "usage: $0 bots [rounds] | human" >&2; exit 1 ;; esac

"$HERE/run.sh"
sleep 25
# The map load is slow under QEMU; a bot spawned before it finishes is wiped.
say "map jev_duel" 0
for _ in $(seq 1 45); do [ "$(loads)" -ge 2 ] && break; sleep 2; done
for c in "log off" "mp_freezetime 0" "mp_timelimit 0" "bot_quota 0" "jev_spawn 1"; do say "$c"; done
sleep 8
say "jev_bridge $BRIDGE_HOST $OBS"

if [ "$MODE" = bots ]; then
  say "bot_difficulty ${3:-0}"
  # One weapon for both sides (WEAPON=weapon_m4a1 to change; default AWP).
  say "jev_weapon ${WEAPON:-weapon_awp}"
  say "bot_add_ct" 6
  say "jev_duel ${2:-10}" 0
  echo "running; follow with: sed 's/\x1b\[[0-9;]*m//g' /tmp/$NAME.console | grep jev"
else
  say "mp_roundtime 9" 0
  echo "ready: open http://127.0.0.1:$HTTP/, click Play, pick Counter-Terrorist"
fi
