import test from "node:test";
import assert from "node:assert/strict";
import { loadProviderCore as loadCore } from "../../src/app/(dashboard)/dashboard/providers/providerPageUtils.ts";

const json = (payload: unknown) => new Response(JSON.stringify(payload), {
  headers: { "Content-Type": "application/json" },
});

// Regression initially reproduced against the old all-in-one loader.
test("core data paints without requesting or waiting for optional provider enrichment", async () => {
  const urls: string[] = [];
  const fake = async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).includes("expiration") || String(url).includes("openrouter-stats")) {
      return new Promise<Response>(() => {});
    }
    return json(String(url) === "/api/providers" ? { connections: [{ id: "test" }] }
      : String(url) === "/api/provider-nodes" ? { nodes: [] }
      : { blockedProviders: [] });
  };
  let outer: ReturnType<typeof setTimeout>;
  const result = await Promise.race([
    loadCore(fake as typeof fetch, 500),
    new Promise<null>((resolve) => { outer = setTimeout(() => resolve(null), 80); }),
  ]);
  clearTimeout(outer!);
  assert.ok(result, "critical provider data is still waiting for optional stats");
  assert.equal(result.connections[0].id, "test");
  assert.deepEqual(urls.sort(), ["/api/provider-nodes", "/api/providers", "/api/settings"].sort());
});

test("settings unavailable still returns readable cards with explicitly unknown mutation policy", async () => {
  const failingSettings = async (url: string | URL | Request) => String(url) === "/api/settings"
    ? new Response("Unauthorized", { status: 401 })
    : json(String(url) === "/api/providers" ? { connections: [{ id: "test" }] } : { nodes: [] });
  const data = await loadCore(failingSettings as typeof fetch, 100);
  assert.equal(data.connections[0].id, "test");
  assert.equal(data.settings, null);
  assert.equal(data.blockedProviders, null);
  assert.match(data.policyError ?? "", /401/);
});

test("successful settings may omit the optional blockedProviders key", async () => {
  const fake = async (url: string | URL | Request) => json(String(url) === "/api/providers"
    ? { connections: [] } : String(url) === "/api/provider-nodes" ? { nodes: [] }
    : { requireLogin: true, settingsRevision: 1 });
  const data = await loadCore(fake as typeof fetch, 100);
  assert.deepEqual(data.blockedProviders, []);
  assert.equal(data.policyError, null);
});
