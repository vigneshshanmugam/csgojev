#!/bin/sh
# Regenerates the geometry header, then builds the plugin in an i386 container
# and drops the result where the overlay mounts it.
#
#   DEST=../addons-test/jevbot plugin/build.sh   # install elsewhere, for ADDONS= under test
set -e
cd "$(dirname "$0")"
DEST=${DEST:-../overlay/addons/jevbot}

./geom.sh

docker run --rm --platform linux/386 \
	-v "$(cd .. && pwd)":/work -w /work/plugin \
	i386/debian:bookworm-slim \
	sh -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq g++ make >/dev/null 2>&1 && make"

mkdir -p "$DEST"
cp Release/jevbot_mm_i386.so "$DEST/"
echo "build.sh: installed $DEST/jevbot_mm_i386.so"
