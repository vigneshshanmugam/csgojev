#!/usr/bin/env bash
# Rebuild a duel BSP from the prototype geometry.
#
#   cs16/map/build.sh              fast, fullbright jev_duel
#   cs16/map/build.sh split --lit  full compile jev_split
#
# Everything third-party lands in cs16/vendor/ (gitignored): the sdhlt source,
# the compiler binaries, and the WADs copied out of the server image.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VENDOR="$ROOT/cs16/vendor"
TOOLS="$VENDOR/sdhlt/tools"
IMAGE="ghcr.io/balintsoos/cs16-web-server:latest"
BUILDER="debian:bookworm-slim"
LIT=0
LAYOUT=duel
for arg in "$@"; do
  case "$arg" in
    --lit) LIT=1 ;;
    duel|jev_duel) LAYOUT=duel ;;
    split|jev_split) LAYOUT=split ;;
    *) echo "usage: cs16/map/build.sh [duel|split] [--lit]" >&2; exit 1 ;;
  esac
done
MAP=jev_$LAYOUT

# 1. WADs out of the server image -----------------------------------------
for wad in cs_dust.wad; do
  if [ ! -f "$VENDOR/$wad" ]; then
    echo "==> extracting $wad from $IMAGE"
    cid=$(docker create --platform linux/386 "$IMAGE")
    docker cp "$cid:/xashds/cstrike/$wad" "$VENDOR/$wad"
    docker rm "$cid" >/dev/null
  fi
done

# 2. sdhlt compilers -------------------------------------------------------
if [ ! -d "$VENDOR/sdhlt" ]; then
  echo "==> cloning sdhlt"
  git clone --depth 1 https://github.com/seedee/sdhlt.git "$VENDOR/sdhlt"
fi
if [ ! -x "$TOOLS/sdHLCSG" ]; then
  echo "==> building sdhlt"
  docker run --rm -v "$VENDOR/sdhlt":/src -w /src "$BUILDER" bash -c \
    "apt-get update -qq && apt-get install -y -qq build-essential cmake >/dev/null \
     && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j\$(nproc)"
fi

# 3. .map from the prototype geometry --------------------------------------
echo "==> generating $MAP.map"
( cd "$ROOT" && npx tsx cs16/map/gen.ts "$LAYOUT" )

# 4. compile ---------------------------------------------------------------
mkdir -p "$HERE/out"
cp "$HERE/$MAP.map" "$HERE/out/$MAP.map"

# Do not embed textures (-nowadtextures): a 340KB BSP stalls the browser download at ~30%. cs_dust.wad ships with the client.
steps="sdHLCSG /work/$MAP && sdHLBSP /work/$MAP"
if [ "$LIT" = 1 ]; then
  steps="$steps && sdHLVIS /work/$MAP && sdHLRAD /work/$MAP"
else
  echo "==> fullbright build (skipping VIS and RAD; pass --lit for the full compile)"
fi

echo "==> compiling"
docker run --rm \
  -v "$TOOLS":/tools -v "$VENDOR":/wads -v "$HERE/out":/work \
  -w /tools "$BUILDER" bash -c "export PATH=/tools:\$PATH; $steps"

ls -la "$HERE/out/$MAP.bsp"
echo "==> $HERE/out/$MAP.bsp"
