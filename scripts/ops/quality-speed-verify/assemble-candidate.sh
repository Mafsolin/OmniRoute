#!/bin/bash
# Assemble runtime-candidate-<sha> from .build/next/standalone with a REAL pruned node_modules.
set -eu
SRC=/opt/omniroute-quality-speed-20261007
SHA=$(cd "$SRC" && git rev-parse --short HEAD)
CAND=/opt/omniroute-quality-speed-data/runtime-candidate-$SHA
R=/opt/omniroute-staging/runtime-ee674018e

echo "assembling $CAND (sha $SHA)"
rm -rf "$CAND"
cp -a "$SRC/.build/next/standalone" "$CAND"
rm -rf "$CAND/node_modules"
cp -a "$R/node_modules" "$CAND/node_modules"

echo "-- dep manifests must match between checkout and pruned runtime --"
sha256sum "$SRC/package.json" "$SRC/package-lock.json" | awk '{print $1}'
sha256sum "$R/package.json" "$R/package-lock.json" | awk '{print $1}'

echo "-- artifact markers --"
for f in server-ws.mjs BUILD_SHA peer-stamp.mjs systemd-notify.mjs http-method-guard.cjs head-response-guard.cjs; do
  if [ -e "$CAND/$f" ]; then echo "OK $f"; else echo "MISSING $f"; fi
done
echo "BUILD_SHA=$(cat "$CAND/BUILD_SHA" 2>/dev/null || echo none)"
echo "node_modules packages: $(ls "$CAND/node_modules" | wc -l)"
du -sh "$CAND" | awk '{print "candidate size:", $1}'
