#!/bin/bash
# Canonical F2 stage: open bootstrap, no password, only F2 synthetic providers allowed.
set -u
CAND=/opt/omniroute-quality-speed-data/runtime-candidate-2990ad921
B=http://127.0.0.1:20138
echo "== stop stage =="
systemctl stop omniroute-quality-stage 2>/dev/null || true
systemctl reset-failed omniroute-quality-stage 2>/dev/null || true
sleep 2
echo "== auth-state cleanup (E1 password residue) + cloud sync off =="
DB=/opt/omniroute-quality-speed-stage-data/storage.sqlite
if [ -f "$DB" ]; then
  cp -a "$DB" "$DB.reset-$(date +%Y%m%d-%H%M%S).bak"
  sqlite3 "$DB" "DELETE FROM key_value WHERE key IN ('setupComplete','password');"
  sqlite3 "$DB" "INSERT OR REPLACE INTO key_value (namespace,key,value) VALUES ('settings','requireLogin','false');"
  sqlite3 "$DB" "INSERT OR REPLACE INTO key_value (namespace,key,value) VALUES ('settings','cloudEnabled','false');"
fi
echo "== start canonical F2 stage (open bootstrap, no password) =="
systemd-run --unit=omniroute-quality-stage \
  --property=MemoryMax=3G --property=MemorySwapMax=512M --property=CPUQuota=200% \
  --property=WorkingDirectory="$CAND" \
  --setenv=HOME=/root --setenv=NODE_ENV=production \
  --setenv=DATA_DIR=/opt/omniroute-quality-speed-stage-data \
  --setenv=HOST=127.0.0.1 --setenv=HOSTNAME=127.0.0.1 --setenv=PORT=20138 --setenv=DASHBOARD_PORT=20138 \
  --setenv=OMNIROUTE_DISABLE_BACKGROUND_SERVICES=true \
  --setenv=OMNIROUTE_E2E_BOOTSTRAP_MODE=open \
  --setenv=OMNIROUTE_ENABLE_LIVE_WS=false \
  --setenv=OMNIROUTE_SKIP_DB_HEALTHCHECK=1 \
  --setenv=DISABLE_SQLITE_AUTO_BACKUP=true \
  /usr/bin/node "$CAND/server-ws.mjs" >/dev/null 2>&1 || { echo "FAIL: systemd-run could not start stage"; exit 1; }
for i in $(seq 1 480); do curl -s -o /dev/null -m 2 $B/healthz && { echo "healthz ok ~$((i/2))s"; break; }; sleep 0.5; done
curl -s -o /dev/null -m 2 $B/healthz || { echo "FAIL: stage healthz unreachable after boot"; exit 1; }
echo "== isolation: remove non-F2 providers =="
curl -s -m 20 $B/api/providers | python3 -c "
import sys, json
d = json.load(sys.stdin)
for c in d.get('connections', []):
    if not str(c.get('name','')).startswith('F2 synthetic '):
        print(c['id'], c.get('provider',''))
" | while read -r cid cprov; do
  [ -n "$cid" ] || continue
  echo "deleting connection $cid (provider node $cprov)"
  echo "  conn delete: $(curl -s -o /dev/null -w '%{http_code}' -m 20 -X DELETE $B/api/providers/$cid)"
  echo "  node delete: $(curl -s -o /dev/null -w '%{http_code}' -m 20 -X DELETE $B/api/provider-nodes/$cprov)"
done
echo "-- connections after cleanup --"
curl -s -m 20 $B/api/providers | python3 -c "import sys,json; d=json.load(sys.stdin); print([c.get('name') for c in d.get('connections',[])])"
echo "-- settings sanity --"
curl -s -m 20 $B/api/settings | python3 -c "import sys,json; d=json.load(sys.stdin); print({'requireLogin': d.get('requireLogin'), 'cloudEnabled': d.get('cloudEnabled'), 'enableCloudSync': d.get('enableCloudSync')})"
echo "== f2 stage reset done =="
