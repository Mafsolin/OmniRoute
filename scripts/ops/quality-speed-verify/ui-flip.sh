#!/bin/bash
# UI static flip: copy new static chunks and atomically flip the symlink.
set -eu
NEW=/opt/omniroute-staging/runtime-2990ad921/.build/next/static
WWW=/var/www/omniroute-ui-static
echo "source static: $(du -sh "$NEW" | awk '{print $1}')"
rm -rf "$WWW/2990ad921"
cp -a "$NEW" "$WWW/2990ad921"
ln -sfn "$WWW/2990ad921" "$WWW/current.new"
mv -T "$WWW/current.new" "$WWW/current"
echo "current -> $(readlink "$WWW/current")"
CHUNK=$(curl -sk -H "Host: api.mafsolin.space" https://127.0.0.1/login 2>/dev/null | grep -oE '/_next/static/[^"]+\.js' | head -1)
echo "chunk from /login: $CHUNK"
if [ -n "$CHUNK" ]; then
  echo "chunk fetch: $(curl -sk -o /dev/null -w '%{http_code}' -H "Host: api.mafsolin.space" "https://127.0.0.1$CHUNK")"
fi
echo "== ui flip done =="
