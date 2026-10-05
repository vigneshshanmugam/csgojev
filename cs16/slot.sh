# Sourced by run.sh, duel.sh and bench.sh. One SLOT number picks a whole
# isolated server: container, browser ports and the sidecar's UDP pair, so
# several servers (and agents) can run side by side without crossing wires.
#
#   SLOT=0 (default)  cs16-jev    http :27036  webrtc :27038  obs :27100  intent :27101
#   SLOT=1            cs16-jev-1  http :27046  webrtc :27048  obs :27110  intent :27111
#   SLOT=n            ...         +10n for every port
#
# Pair each server with a sidecar on the same slot: SLOT=1 pnpm sidecar.
# Any of NAME, HTTP, PORT, OBS, INTENT can still be set directly.
SLOT=${SLOT:-0}
if [ "$SLOT" = 0 ]; then NAME=${NAME:-cs16-jev}; else NAME=${NAME:-cs16-jev-$SLOT}; fi
HTTP=${HTTP:-$((27036 + 10 * SLOT))}
PORT=${PORT:-$((27038 + 10 * SLOT))}
OBS=${OBS:-$((27100 + 10 * SLOT))}
INTENT=${INTENT:-$((27101 + 10 * SLOT))}
# The host as seen from inside a Docker Desktop container; the plugin's default.
BRIDGE_HOST=${BRIDGE_HOST:-192.168.65.254}
export SLOT NAME HTTP PORT OBS INTENT BRIDGE_HOST
