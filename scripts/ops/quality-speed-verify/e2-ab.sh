#!/bin/bash
# E2 A/B: profile the cold catalog build on the new candidate and the old one.
# Stage is restarted with --inspect on loopback only; nothing hits /v1/models before the profiled fetch.
set -u
DATA=/opt/omniroute-quality-speed-data
NEW=$DATA/runtime-candidate-2990ad921
OLD=/opt/omniroute-quality-speed-data/runtime-candidate-ee674018e
B=http://127.0.0.1:20138
OUTDIR=/var/lib/omniroute-maintenance

restart_with_inspect() {
  local CAND="$1"
  systemctl stop omniroute-quality-stage 2>/dev/null || true
  systemctl reset-failed omniroute-quality-stage 2>/dev/null || true
  sleep 2
  systemd-run --unit=omniroute-quality-stage \
    --property=MemoryMax=3G --property=MemorySwapMax=512M --property=CPUQuota=200% \
    --property=WorkingDirectory="$CAND" \
    --setenv=HOME=/root --setenv=NODE_ENV=production \
    --setenv=DATA_DIR=/opt/omniroute-quality-speed-stage-data \
    --setenv=PORT=20138 --setenv=HOSTNAME=127.0.0.1 \
    --setenv=OMNIROUTE_DISABLE_BACKGROUND_SERVICES=true \
    --setenv=OMNIROUTE_ENABLE_LIVE_WS=false \
    --setenv=OMNIROUTE_SKIP_DB_HEALTHCHECK=1 \
    --setenv=DISABLE_SQLITE_AUTO_BACKUP=true \
    --setenv=INITIAL_PASSWORD=e1-stage-local-do-not-reuse \
    /usr/bin/node --inspect=127.0.0.1:9229 "$CAND/server-ws.mjs" >/dev/null 2>&1 \
    || { echo "FAIL: systemd-run failed for $CAND"; return 1; }
  local i
  for i in $(seq 1 360); do
    if curl -s -o /dev/null -m 2 $B/healthz; then echo "boot+healthz ok in ~$((i/2))s ($CAND)"; return 0; fi
    sleep 0.5
  done
  echo "FAIL: no healthz for $CAND"
  return 1
}

stop_stage() { systemctl stop omniroute-quality-stage 2>/dev/null || true; systemctl reset-failed omniroute-quality-stage 2>/dev/null || true; sleep 1; }

echo "== E2 profile: NEW candidate =="
restart_with_inspect "$NEW" || exit 1
echo "-- inspector check --"
curl -s -m 5 http://127.0.0.1:9229/json/version | head -c 160; echo
node $DATA/e2-profile.mjs "$OUTDIR/catalog-2990ad921.cpuprofile" || { echo "FAIL: profile NEW"; stop_stage; exit 1; }
stop_stage

echo "== E2 profile: OLD candidate =="
restart_with_inspect "$OLD" || exit 1
node $DATA/e2-profile.mjs "$OUTDIR/catalog-ee674018e.cpuprofile" || { echo "FAIL: profile OLD"; stop_stage; exit 1; }
stop_stage

echo "== E2 analyze: NEW vs OLD =="
python3 $DATA/e2-analyze.py "$OUTDIR/catalog-2990ad921.cpuprofile" "$OUTDIR/catalog-ee674018e.cpuprofile" 2>&1 | head -90

echo "== restart stage (final state, no inspect) =="
stop_stage
systemd-run --unit=omniroute-quality-stage \
  --property=MemoryMax=3G --property=MemorySwapMax=512M --property=CPUQuota=200% \
  --property=WorkingDirectory="$NEW" \
  --setenv=HOME=/root --setenv=NODE_ENV=production \
  --setenv=DATA_DIR=/opt/omniroute-quality-speed-stage-data \
  --setenv=PORT=20138 --setenv=HOSTNAME=127.0.0.1 \
  --setenv=OMNIROUTE_DISABLE_BACKGROUND_SERVICES=true \
  --setenv=OMNIROUTE_ENABLE_LIVE_WS=false \
  --setenv=OMNIROUTE_SKIP_DB_HEALTHCHECK=1 \
  --setenv=DISABLE_SQLITE_AUTO_BACKUP=true \
  --setenv=INITIAL_PASSWORD=e1-stage-local-do-not-reuse \
  /usr/bin/node "$NEW/server-ws.mjs" >/dev/null 2>&1
for i in $(seq 1 360); do curl -s -o /dev/null -m 2 $B/healthz && { echo "stage final: up (no inspect)"; break; }; sleep 0.5; done
echo "== E2 done =="
