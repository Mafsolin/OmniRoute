#!/bin/bash
# Candidate packaging smoke: boot on spare port with throwaway DATA_DIR, verify key endpoints.
set -u
CAND=${CAND:-/opt/omniroute-quality-speed-data/runtime-candidate-2990ad921}
SD=$(mktemp -d /opt/omniroute-quality-speed-data/tmp/smoke-XXXXXX)
U=omniroute-cand-smoke-$RANDOM
echo "smoke dir=$SD unit=$U cand=$CAND"

systemctl stop $U 2>/dev/null || true
systemd-run --unit=$U \
  --property=MemoryMax=3G --property=MemorySwapMax=512M \
  --property=WorkingDirectory="$CAND" \
  --setenv=HOME=/root --setenv=NODE_ENV=production \
  --setenv=DATA_DIR="$SD" --setenv=PORT=20133 --setenv=HOSTNAME=127.0.0.1 \
  --setenv=OMNIROUTE_DISABLE_BACKGROUND_SERVICES=true \
  --setenv=OMNIROUTE_ENABLE_LIVE_WS=false \
  --setenv=OMNIROUTE_SKIP_DB_HEALTHCHECK=1 \
  --setenv=DISABLE_SQLITE_AUTO_BACKUP=true \
  /usr/bin/node "$CAND/server-ws.mjs" >/dev/null 2>&1

OK=0
for i in $(seq 1 150); do
  H=$(curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:20133/healthz 2>/dev/null || true)
  if [ "$H" = "200" ]; then OK=1; echo "healthz 200 after ${i}s"; break; fi
  sleep 1
done
if [ "$OK" != "1" ]; then
  echo "FAIL: healthz never returned 200 (last=$H)"
  journalctl -u $U --no-pager 2>/dev/null | tail -15
  systemctl stop $U 2>/dev/null || true
  exit 1
fi

echo "== endpoint checks =="
for ep in /healthz /v1/models /api/usage/model-latency-stats; do
  R=$(curl -s -o /dev/null -w "%{http_code} %{time_total}s" -m 90 http://127.0.0.1:20133$ep)
  echo "$ep -> $R"
done

echo "== shutdown =="
systemctl stop $U 2>/dev/null || true
sleep 1
systemctl is-active $U 2>/dev/null || echo "unit stopped"
rm -rf "$SD"
echo "smoke done"
