/**
 * GET /api/v1/providers/[provider]/models — compatible-node filter.
 *
 * The unified catalog publishes compatible-node models under the node's
 * configured PREFIX in the public `owned_by` field (#8327 / resolvePublicOwnerId).
 * The route must filter by that same public key; filtering by the raw node id
 * (the `[provider]` param) returned an empty list for every compatible
 * connection — the provider Test slide-over then had no models to pick.
 *
 * Run: node --import tsx/esm --test tests/unit/provider-models-compatible-filter.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compat-filter-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const routeModule = await import("../../src/app/api/v1/providers/[provider]/models/route.ts");

const NODE_ID = "openai-compatible-chat-a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const CONN_ID = "11111111-2222-3333-4444-555555555555";
const PREFIX = "testnode";

function seedCompatibleNode() {
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO provider_nodes (id, type, name, prefix, api_type, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(NODE_ID, "openai-compatible", "Test Node", PREFIX, "chat", "https://example.test/v1", now, now);
  db.prepare(
    "INSERT INTO provider_connections (id, provider, name, api_key, is_active, created_at, updated_at, provider_specific_data) VALUES (?, ?, ?, ?, 1, ?, ?, ?)"
  ).run(
    CONN_ID,
    NODE_ID,
    "test-conn",
    "sk-test-not-real",
    now,
    now,
    JSON.stringify({ prefix: PREFIX, apiType: "chat", baseUrl: "https://example.test/v1", nodeName: "Test Node" })
  );
  db.prepare(
    "INSERT INTO key_value (namespace, key, value) VALUES ('syncedAvailableModels', ?, ?)"
  ).run(
    `${NODE_ID}:${CONN_ID}`,
    JSON.stringify([
      { id: "model-one", name: "model-one", source: "imported" },
      { id: "org/model-two", name: "org/model-two", source: "imported" },
    ])
  );
}

test.beforeEach(() => {
  core.resetDbInstance();
  seedCompatibleNode();
  readCache.invalidateDbCache();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("returns the compatible node's models although the catalog publishes owned_by as the node prefix", async () => {
  const res = await routeModule.GET(
    new Request(`http://localhost/api/v1/providers/${NODE_ID}/models`),
    { params: Promise.resolve({ provider: NODE_ID }) }
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? []).map((m) => m.id).sort();
  assert.deepEqual(ids, ["model-one", "org/model-two"]);
});
