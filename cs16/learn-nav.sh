#!/usr/bin/env bash
# Let zBot learn a real navmesh for one of our maps, outside any comparison.
#
#   cs16/learn-nav.sh jev_split        # SLOT=8 by default; saves cs16/gamedata/maps/jev_split.nav
#
# The first `bot_add` on a map with no .nav starts zBot's own learn process
# (about 15 minutes under QEMU) and may restart the server. The mesh lands in
# czero/maps/ (the plugin spoofs the game dir), so this polls for the file,
# waits for its size to settle, and copies it out. A placeholder copy of another
# map's mesh makes zBot path on the wrong geometry, so it is skipped here.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAP=${1:?usage: cs16/learn-nav.sh <map>}
export SLOT=${SLOT:-8}
. "$HERE/slot.sh"
LOG="/tmp/$NAME.console"
TIMEOUT_MIN=${TIMEOUT_MIN:-45}

SKIP_NAV="$MAP.nav" "$HERE/run.sh"
sleep 25
"$HERE/run.sh" say "map $MAP"; sleep 20
"$HERE/run.sh" say "bot_quota 0"; sleep 2
"$HERE/run.sh" say "bot_add_ct"
echo "learn-nav: waiting for $MAP.nav (up to $TIMEOUT_MIN min)"
last=-1
for i in $(seq 1 $((TIMEOUT_MIN * 2))); do
  size=$(docker exec "$NAME" sh -c "stat -c %s /xashds/czero/maps/$MAP.nav 2>/dev/null || stat -c %s /xashds/cstrike/maps/$MAP.nav 2>/dev/null" 2>/dev/null || true)
  if [ -n "$size" ] && [ "$size" = "$last" ] && [ "$size" -gt 1000 ]; then break; fi
  last=${size:--1}
  [ $((i % 10)) -eq 0 ] && echo "learn-nav: $((i / 2)) min, nav size ${size:-none}"
  sleep 30
done
[ -n "${size:-}" ] && [ "$size" -gt 1000 ] || { echo "learn-nav: no navmesh after $TIMEOUT_MIN min" >&2; exit 1; }
src=/xashds/czero/maps/$MAP.nav
docker exec "$NAME" test -f "$src" || src=/xashds/cstrike/maps/$MAP.nav
docker cp "$NAME:$src" "$HERE/gamedata/maps/$MAP.nav.new"
echo "learn-nav: saved $HERE/gamedata/maps/$MAP.nav.new ($size bytes); compare with jev_duel.nav and rename it over $MAP.nav"
