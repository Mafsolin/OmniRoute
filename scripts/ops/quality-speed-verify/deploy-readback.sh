#!/bin/bash
# Deploy readback: all post-switch checks. Never prints the key.
set -u
DB=/opt/omniroute-staging/data/storage.sqlite
B=http://127.0.0.1:20128
K=$(sqlite3 "file:$DB?mode=ro" "SELECT key FROM api_keys WHERE name='hermes' LIMIT 1" 2>/dev/null)
[ -n "$K" ] || K=$(sqlite3 "file:$DB?mode=ro" "SELECT key FROM api_keys LIMIT 1" 2>/dev/null)
if [ -z "$K" ]; then echo "FAIL: no api key in DB"; exit 1; fi

echo "runtime BUILD_SHA: $(cat /opt/omniroute-staging/runtime-2990ad921/BUILD_SHA 2>/dev/null || echo MISSING)"
echo "healthz: $(curl -s -o /dev/null -w '%{http_code} %{time_total}s' -m 15 $B/healthz)"
echo "models:  $(curl -s -o /dev/null -w '%{http_code} %{time_total}s' -m 90 -H "Authorization: Bearer $K" $B/v1/models)"

M=$(curl -s -m 90 -H "Authorization: Bearer $K" $B/v1/models | python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = [m.get('id','') for m in d.get('data',[])]
pick = [i for i in ids if i.startswith('cx/')]
print(pick[0] if pick else (ids[0] if ids else ''))
" 2>/dev/null)
echo "gen model picked: ${M:-NONE}"

if [ -n "${M:-}" ]; then
  echo "chat/completions: $(curl -s -o /dev/null -w '%{http_code} %{time_total}s' -m 150 -X POST $B/v1/chat/completions -H "Authorization: Bearer $K" -H 'Content-Type: application/json' -d "{\"model\":\"$M\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: pong\"}],\"stream\":false}")"
  echo "responses:        $(curl -s -o /dev/null -w '%{http_code} %{time_total}s' -m 150 -X POST $B/v1/responses -H "Authorization: Bearer $K" -H 'Content-Type: application/json' -d "{\"model\":\"$M\",\"input\":\"Reply with exactly one word: pong\"}")"
fi

echo "latency-stats: $(curl -s -o /dev/null -w '%{http_code} %{time_total}s' -m 90 -H "Authorization: Bearer $K" $B/api/usage/model-latency-stats)"
echo "NRestarts: $(systemctl show omniroute -p NRestarts --value)"
echo "unit ActiveState: $(systemctl show omniroute -p ActiveState --value)/$(systemctl show omniroute -p SubState --value)"
echo "lag/error lines in journal (last 3 min): $(journalctl -u omniroute --no-pager --since '-3 min' | grep -cE 'event-loop lag|\[ERROR\]')"
echo "recent call_logs (last 3):"
sqlite3 "file:$DB?mode=ro" "SELECT substr(id,1,8), model_id, status_code, datetime(created_at,'localtime') FROM call_logs ORDER BY created_at DESC LIMIT 3;" 2>/dev/null
echo "== readback done =="
