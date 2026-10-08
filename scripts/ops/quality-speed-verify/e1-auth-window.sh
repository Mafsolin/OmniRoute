#!/bin/bash
# E1 auth-reflection probe: how fast does /v1/models reflect key deletion?
set -u
K=$(sqlite3 "file:/opt/omniroute-staging/data/storage.sqlite?mode=ro" "SELECT key FROM api_keys WHERE name='hermes' LIMIT 1")
B=http://127.0.0.1:20138
C=$(curl -s -m 20 -X POST $B/api/keys -H "Authorization: Bearer $K" -H "Content-Type: application/json" -d '{"name":"e1-refl-t2"}')
NK=$(echo "$C" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")
NI=$(echo "$C" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "created id=$NI"
probe() { curl -s -o /dev/null -w "%{http_code}" -m 20 -H "Authorization: Bearer $NK" $B/v1/models; }
echo "t0 (fresh key): $(probe)"
curl -s -m 20 -X DELETE "$B/api/keys/$NI" -H "Authorization: Bearer $K" -o /dev/null -w "delete http=%{http_code}\n"
echo "after delete +0s: $(probe)"
sleep 5;  echo "after delete +5s: $(probe)"
sleep 25; echo "after delete +30s: $(probe)"
sleep 30; echo "after delete +60s: $(probe)"
sleep 60; echo "after delete +120s: $(probe)"
echo "garbage key control: $(curl -s -o /dev/null -w '%{http_code}' -m 20 -H 'Authorization: Bearer sk-does-not-exist-000' $B/v1/models)"
echo "no key control: $(curl -s -o /dev/null -w '%{http_code}' -m 20 $B/v1/models)"
