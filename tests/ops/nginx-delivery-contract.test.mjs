import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("nginx treats public and dashboard streaming aliases identically without buffering", async () => {
  const config = await readFile(new URL("../../deploy/omni/nginx-site.conf", import.meta.url), "utf8");
  const match = config.match(/location\s+~\s+([^\s{]+)\s*\{([^}]+)\}/);
  assert.ok(match, "dedicated generation route location must exist");
  const paths = new RegExp(match[1]);
  for (const route of ["/v1/chat/completions", "/api/v1/chat/completions", "/v1/responses", "/api/v1/responses"]) {
    assert.ok(paths.test(route), `${route} must use the streaming location`);
  }
  for (const route of ["/v1/models", "/api/v1/models", "/v1/responses/extra", "/api/settings"]) {
    assert.ok(!paths.test(route), `${route} must not be matched as generation`);
  }
  assert.match(match[2], /proxy_buffering\s+off;/);
  assert.match(match[2], /proxy_http_version\s+1\.1;/);
  assert.match(match[2], /proxy_set_header\s+Upgrade\s+\$http_upgrade;/);
  assert.match(match[2], /limit_req_status\s+429;/);
});
