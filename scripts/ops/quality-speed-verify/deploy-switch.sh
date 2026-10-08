#!/bin/bash
# Deploy switch: backup, copy runtime, flip unit, restart, wait warmup.
set -u
TS=$(date +%Y%m%d-%H%M%S)
CAND=/opt/omniroute-quality-speed-data/runtime-candidate-2990ad921
NEW=/opt/omniroute-staging/runtime-2990ad921
BK=/opt/omniroute-staging/backup/pre-switch-$TS
DB=/opt/omniroute-staging/data/storage.sqlite

echo "== backup =="
mkdir -p "$BK"
cp /etc/systemd/system/omniroute.service "$BK/"
echo "unit file backed up to $BK"
sqlite3 "$DB" ".backup '$BK/storage.sqlite'" && echo "db backup ok ($(du -sh "$BK/storage.sqlite" | awk '{print $1}'))"

echo "== copy runtime =="
rm -rf "$NEW"
cp -a "$CAND" "$NEW" && echo "runtime copied: $(du -sh "$NEW" | awk '{print $1}')"
echo "BUILD_SHA=$(cat "$NEW/BUILD_SHA" 2>/dev/null || echo MISSING)"

echo "== switch unit =="
sed -i "s|runtime-ee674018e|runtime-2990ad921|g" /etc/systemd/system/omniroute.service
echo "unit now references: $(grep -o "runtime-[a-f0-9]*" /etc/systemd/system/omniroute.service | head -2 | tr '\n' ' ')"
systemctl daemon-reload && systemctl restart omniroute
echo "restart issued at $(date +%H:%M:%S)"

echo "== warmup wait (max 6 min) =="
H=000
for i in $(seq 1 720); do
  H=$(curl -s -o /dev/null -w "%{http_code}" -m 3 http://127.0.0.1:20128/healthz 2>/dev/null || true)
  if [ "$H" = "200" ]; then echo "healthz 200 after ~$((i/2))s"; break; fi
  sleep 0.5
done
if [ "$H" != "200" ]; then
  echo "NOTE: healthz still $H after 6 min (warmup may run longer; check journal before judging)"
  journalctl -u omniroute --no-pager --since "-2 min" | tail -8
fi
echo "== switch script done =="
