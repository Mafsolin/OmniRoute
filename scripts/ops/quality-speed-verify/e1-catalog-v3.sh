#!/bin/bash
# E1 v3: cold/warm catalog timing + auth reflection on stage, with auth ENFORCED.
# Usage: CAND=/path/runtime-candidate-<sha> bash e1-catalog-v3.sh
# Stage-only mutations (setupComplete via INITIAL_PASSWORD, temp keys, settings flip).
# Never restarts prod; never prints secrets.
set -u
D=/opt/omniroute-quality-speed-data/e1
mkdir -p "$D"
LOG="$D/e1-results.txt"
: > "$LOG"
say() { echo "$@" | tee -a "$LOG"; }
CAND=${CAND:-/opt/omniroute-quality-speed-data/runtime-candidate-ee674018e}
B=http://127.0.0.1:20138
KEYFILE=$D/stage-key.txt

# --- 0. ensure a stage admin key exists (auth is still open right now) ---
if [ ! -s "$KEYFILE" ]; then
  C=$(curl -s -m 20 -X POST $B/api/keys -H "Content-Type: application/json" -d '{"name":"e1-stage-admin","scopes":["manage"]}')
  echo "$C" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])" > "$KEYFILE" 2>/dev/null || true
  chmod 600 "$KEYFILE" 2>/dev/null || true
fi
SK=$(cat "$KEYFILE" 2>/dev/null || true)
if [ -z "$SK" ]; then say "FAIL: no stage key (create shape?)"; exit 1; fi
say "== E1 $(date -Is) candidate=$(basename "$CAND") =="
say "stage admin key present (value never printed)"

# --- 1. restart stage WITH auth enabled ---
say "-- stage restart with auth (INITIAL_PASSWORD set on first boot) --"
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
  /usr/bin/node "$CAND/server-ws.mjs" >/dev/null 2>&1 || { say "FAIL: systemd-run could not start stage"; exit 1; }

T0=$(date +%s.%N)
BOOTED=0
for i in $(seq 1 360); do
  if curl -s -o /dev/null -m 2 $B/healthz; then BOOTED=1; break; fi
  sleep 0.5
done
if [ "$BOOTED" != "1" ]; then say "FAIL: stage never answered /healthz (180s)"; exit 1; fi
T1=$(date +%s.%N)
echo "$T0 $T1" | awk '{printf "stage boot to first healthz: %.1fs\n", $2-$1}' | tee -a "$LOG"

# --- 2. control: auth must now be enforced on loopback ---
CTL1=$(curl -s -o /dev/null -w "%{http_code}" -m 20 $B/v1/models)
CTL2=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -H "Authorization: Bearer $SK" $B/v1/models)
say "control: no-key models=$CTL1 (expect 401), stage-key models=$CTL2 (expect 200)"

# --- 3. cold + concurrent health ---
( for i in $(seq 1 40); do
    printf "hz %s\n" "$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -m 5 $B/healthz)"
    sleep 0.25
  done ) > "$D/concurrent-health.txt" &
HZPID=$!
t_url() { local o; o=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" -m 60 -H "Authorization: Bearer $SK" "$1"); echo "$2: $o" | tee -a "$LOG"; }
t_url $B/v1/models "stage cold read1"
t_url $B/v1/models "stage read2"
wait $HZPID 2>/dev/null
for i in 1 2 3; do t_url $B/v1/models "stage warm read$i"; done
awk '{print $2}' "$D/concurrent-health.txt" | sort -n | tail -3 | tr '\n' ' ' | xargs echo "top3 slowest healthz (s):" | tee -a "$LOG"
grep -c " 200 " "$D/concurrent-health.txt" | xargs echo "healthz 200 count (of 40):" | tee -a "$LOG"

# --- 4. auth reflection: create -> read -> delete -> read ---
say "-- auth reflection (delete must reflect on the next read) --"
C=$(curl -s -m 20 -X POST $B/api/keys -H "Authorization: Bearer $SK" -H "Content-Type: application/json" -d '{"name":"e1-refl"}')
NK=$(echo "$C" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',''))" 2>/dev/null)
NI=$(echo "$C" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -n "$NK" ] && [ -n "$NI" ]; then
  R0=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -H "Authorization: Bearer $NK" $B/v1/models)
  curl -s -m 20 -X DELETE "$B/api/keys/$NI" -H "Authorization: Bearer $SK" -o /dev/null
  R1=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -H "Authorization: Bearer $NK" $B/v1/models)
  sleep 2
  R2=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -H "Authorization: Bearer $NK" $B/v1/models)
  say "fresh key read=$R0 (200) | after delete +0s=$R1 | +2s=$R2 (both expect 401)"
else
  say "reflection key create failed (shape)"
fi

# --- 5. hide reflection: settings flip must reflect on the next read ---
say "-- hide reflection (autoRoutingEnabled flip) --"
cnt_auto() { curl -s -m 60 -H "Authorization: Bearer $SK" $B/v1/models | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for m in d.get('data',[]) if str(m.get('id','')).startswith('auto/')))"; }
CUR=$(curl -s -m 20 -H "Authorization: Bearer $SK" $B/api/settings | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('autoRoutingEnabled', True)).lower())" 2>/dev/null)
say "current autoRoutingEnabled=$CUR"
A0=$(cnt_auto)
if [ "$CUR" = "true" ]; then FLIP=false; else FLIP=true; fi
P1=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X PATCH $B/api/settings -H "Authorization: Bearer $SK" -H "Content-Type: application/json" -d "{\"autoRoutingEnabled\":$FLIP}")
A1=$(cnt_auto)
REST=$( [ "$FLIP" = "true" ] && echo false || echo true )
P2=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X PATCH $B/api/settings -H "Authorization: Bearer $SK" -H "Content-Type: application/json" -d "{\"autoRoutingEnabled\":$REST}")
A2=$(cnt_auto)
say "auto/* count before=$A0 | flip to $FLIP (PATCH=$P1) -> $A1 | restore to $REST (PATCH=$P2) -> $A2"
say "== E1 done =="
