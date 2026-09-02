import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchCodexQuota,
  getCodexQuotaCooldownMs,
  invalidateCodexQuotaCache,
  registerCodexConnection,
  registerCodexQuotaFetcher,
} from "../../open-sse/services/codexQuotaFetcher.ts";
import { preflightQuota } from "../../open-sse/services/quotaPreflight.ts";
import {
  clearQuotaMonitors,
  getActiveMonitorCount,
  startQuotaMonitor,
  stopQuotaMonitor,
} from "../../open-sse/services/quotaMonitor.ts";
import { clearSessions, touchSession } from "../../open-sse/services/sessionManager.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearQuotaMonitors();
  clearSessions();
});

test("fetchCodexQuota returns null when no registered credentials exist", async () => {
  const quota = await fetchCodexQuota(`missing-${Date.now()}`);
  assert.equal(quota, null);
});

test("fetchCodexQuota can read credentials directly from the provided connection snapshot", async () => {
  const connectionId = `codex-inline-${Date.now()}`;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 70,
            reset_after_seconds: 45,
          },
          secondary_window: {
            used_percent: 20,
            reset_after_seconds: 300,
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const quota = await fetchCodexQuota(connectionId, {
    accessToken: "inline-token",
    providerSpecificData: {
      workspaceId: "workspace-inline",
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, "Bearer inline-token");
  assert.equal(calls[0].init.headers["chatgpt-account-id"], "workspace-inline");
  assert.equal(quota.percentUsed, 0.7);
  assert.ok(typeof quota.resetAt === "string");

  invalidateCodexQuotaCache(connectionId);
});

test("fetchCodexQuota parses dual-window usage, forwards workspace headers, and caches results", async () => {
  const connectionId = `codex-cache-${Date.now()}`;
  const calls = [];

  registerCodexConnection(connectionId, {
    accessToken: "access-token",
    workspaceId: "workspace-123",
  });

  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 80,
            reset_after_seconds: 60,
          },
          secondary_window: {
            used_percent: 40,
            reset_at: Math.floor((Date.now() + 3600_000) / 1000),
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const first = await fetchCodexQuota(connectionId);
  const second = await fetchCodexQuota(connectionId);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(calls[0].init.headers.Authorization, "Bearer access-token");
  assert.equal(calls[0].init.headers["chatgpt-account-id"], "workspace-123");
  assert.equal(first.percentUsed, 0.8);
  assert.equal(first.window5h.percentUsed, 0.8);
  assert.equal(first.window7d.percentUsed, 0.4);
  assert.deepEqual(second, first);

  invalidateCodexQuotaCache(connectionId);
});

test("fetchCodexQuota evaluates normal and Spark windows independently by requested model", async () => {
  const connectionId = `codex-spark-scope-${Date.now()}`;
  let calls = 0;

  registerCodexConnection(connectionId, {
    accessToken: "access-token-spark",
  });

  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 20, reset_after_seconds: 60 },
          secondary_window: { used_percent: 30, reset_after_seconds: 120 },
        },
        additional_rate_limits: [
          {
            limit_id: "codex_bengalfox",
            limit_name: "GPT-5.3-Codex-Spark",
            metered_feature: "gpt_5_3_codex_spark",
            rate_limit: {
              primary_window: { used_percent: 100, reset_after_seconds: 300 },
              secondary_window: { used_percent: 40, reset_after_seconds: 600 },
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const normal = await fetchCodexQuota(connectionId, { requestedModel: "gpt-5.3-codex" });
  const spark = await fetchCodexQuota(connectionId, { requestedModel: "gpt-5.3-codex-spark" });

  assert.equal(calls, 2, "normal and Spark scopes use separate cache entries");
  assert.equal(normal.percentUsed, 0.3);
  assert.equal(normal.windows?.session.percentUsed, 0.2);
  assert.equal(normal.windows?.weekly.percentUsed, 0.3);
  assert.equal(normal.windows?.gpt_5_3_codex_spark_session, undefined);
  assert.equal(spark.percentUsed, 1);
  assert.equal(spark.windows?.gpt_5_3_codex_spark_session.percentUsed, 1);
  assert.equal(spark.windows?.gpt_5_3_codex_spark_weekly.percentUsed, 0.4);
  assert.equal(spark.windows?.session, undefined);

  const sparkCached = await fetchCodexQuota(connectionId, {
    requestedModel: "gpt-5.3-codex-spark",
  });
  assert.equal(calls, 2);
  assert.deepEqual(sparkCached, spark);

  invalidateCodexQuotaCache(connectionId);
});

test("fetchCodexQuota switches Luna to an available gpt-reserve window after the primary limit", async () => {
  const connectionId = `codex-luna-reserve-${Date.now()}`;
  let calls = 0;

  registerCodexConnection(connectionId, { accessToken: "access-token-luna" });
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        rate_limit: {
          limit_reached: true,
          primary_window: { used_percent: 100, reset_after_seconds: 300 },
          secondary_window: { used_percent: 20, reset_after_seconds: 600 },
        },
        additional_rate_limits: [
          {
            limit_name: "gpt-reserve",
            metered_feature: "base_model_inference",
            rate_limit: {
              primary_window: { used_percent: 0, reset_after_seconds: 3600 },
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const luna = await fetchCodexQuota(connectionId, { requestedModel: "gpt-5.6-luna" });
  const sol = await fetchCodexQuota(connectionId, { requestedModel: "gpt-5.6-sol" });

  assert.equal(calls, 2, "Luna and Sol must not share a reserve-aware cache entry");
  assert.equal(luna?.usingLunaReserve, true);
  assert.equal(luna?.lunaReserveAvailable, true);
  assert.equal(luna?.windows?.session.percentUsed, 0);
  assert.equal(luna?.window7d.percentUsed, 0.2);
  assert.equal(luna?.windows?.weekly.percentUsed, 0.2);
  assert.equal(luna?.allWindows?.["gpt-reserve"]?.percentUsed, 0);
  assert.equal(luna?.limitReached, false);
  assert.equal(sol?.usingLunaReserve, false);
  assert.equal(sol?.windows?.session.percentUsed, 1);

  invalidateCodexQuotaCache(connectionId);
});

test("fetchCodexQuota keeps Luna blocked when the reserve window is exhausted", async () => {
  const connectionId = `codex-luna-reserve-exhausted-${Date.now()}`;
  registerCodexConnection(connectionId, { accessToken: "access-token-luna-exhausted" });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        rate_limit: {
          limit_reached: true,
          primary_window: { used_percent: 100, reset_after_seconds: 300 },
        },
        additional_rate_limits: [
          {
            limit_name: "gpt-reserve",
            rate_limit: {
              primary_window: { used_percent: 100, reset_after_seconds: 3600 },
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const quota = await fetchCodexQuota(connectionId, { requestedModel: "gpt-5.6-luna" });

  assert.equal(quota?.usingLunaReserve, false);
  assert.equal(quota?.lunaReserveAvailable, false);
  assert.equal(quota?.limitReached, true);
  assert.equal(quota?.windows?.session.percentUsed, 1);
  invalidateCodexQuotaCache(connectionId);
});

test("fetchCodexQuota keeps the regular weekly window active while Luna uses reserve", async () => {
  const connectionId = `codex-luna-reserve-weekly-${Date.now()}`;
  registerCodexConnection(connectionId, { accessToken: "access-token-luna-weekly" });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        rate_limit: {
          limit_reached: true,
          primary_window: { used_percent: 100, reset_after_seconds: 300 },
          secondary_window: { used_percent: 100, reset_after_seconds: 600 },
        },
        additional_rate_limits: [
          {
            limit_name: "gpt-reserve",
            rate_limit: { primary_window: { used_percent: 0, reset_after_seconds: 3600 } },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const quota = await fetchCodexQuota(connectionId, { requestedModel: "gpt-5.6-luna" });

  assert.equal(quota?.usingLunaReserve, false, "weekly exhaustion must remain authoritative");
  assert.equal(quota?.windows?.session.percentUsed, 1);
  invalidateCodexQuotaCache(connectionId);
});

test("Codex preflight still applies a near-exhausted weekly window during Luna reserve", async () => {
  const connectionId = `codex-luna-reserve-weekly-cutoff-${Date.now()}`;
  registerCodexQuotaFetcher();
  registerCodexConnection(connectionId, { accessToken: "access-token-luna-weekly-cutoff" });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        rate_limit: {
          limit_reached: true,
          primary_window: { used_percent: 100, reset_after_seconds: 300 },
          secondary_window: { used_percent: 99, reset_after_seconds: 600 },
        },
        additional_rate_limits: [
          {
            limit_name: "gpt-reserve",
            rate_limit: { primary_window: { used_percent: 0, reset_after_seconds: 3600 } },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const result = await preflightQuota(
    "codex",
    connectionId,
    { requestedModel: "gpt-5.6-luna" },
    { resolveMinRemainingPercent: () => 2 }
  );

  assert.equal(result.proceed, false);
  assert.equal(result.reason, "quota_exhausted");
  invalidateCodexQuotaCache(connectionId);
});

test("Codex preflight allows Luna reserve but still blocks Sol on the exhausted regular window", async () => {
  const connectionId = `codex-luna-reserve-preflight-${Date.now()}`;
  registerCodexQuotaFetcher();
  registerCodexConnection(connectionId, { accessToken: "access-token-luna-preflight" });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        rate_limit: {
          limit_reached: true,
          primary_window: { used_percent: 100, reset_after_seconds: 300 },
        },
        additional_rate_limits: [
          {
            limit_name: "gpt-reserve",
            rate_limit: {
              primary_window: { used_percent: 0, reset_after_seconds: 3600 },
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const thresholds = {
    resolveMinRemainingPercent: () => 2,
    resolveWarnRemainingPercent: () => 20,
  };
  const luna = await preflightQuota(
    "codex",
    connectionId,
    { requestedModel: "gpt-5.6-luna" },
    thresholds
  );
  const sol = await preflightQuota(
    "codex",
    connectionId,
    { requestedModel: "gpt-5.6-sol" },
    thresholds
  );

  assert.equal(luna.proceed, true);
  assert.equal(sol.proceed, false);
  invalidateCodexQuotaCache(connectionId);
});

test("fetchCodexQuota drops bad credentials after an authorization failure", async () => {
  const connectionId = `codex-auth-${Date.now()}`;
  let calls = 0;

  registerCodexConnection(connectionId, {
    accessToken: "expired-token",
  });

  globalThis.fetch = async () => {
    calls++;
    return new Response("unauthorized", { status: 401 });
  };

  const first = await fetchCodexQuota(connectionId);
  const second = await fetchCodexQuota(connectionId);

  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(calls, 1);
});

test("getCodexQuotaCooldownMs prefers the 7d window before the 5h window", () => {
  const now = Date.now();
  const quota = {
    used: 99,
    total: 100,
    percentUsed: 0.99,
    window5h: {
      percentUsed: 0.99,
      resetAt: new Date(now + 60_000).toISOString(),
    },
    window7d: {
      percentUsed: 0.97,
      resetAt: new Date(now + 300_000).toISOString(),
    },
    limitReached: false,
  };

  const cooldownMs = getCodexQuotaCooldownMs(quota);

  assert.ok(cooldownMs >= 295_000);
  assert.ok(cooldownMs <= 300_000);
});

test("registerCodexQuotaFetcher exposes Codex quota to preflight and monitor flows", async () => {
  const connectionId = `codex-preflight-${Date.now()}`;

  registerCodexQuotaFetcher();
  registerCodexConnection(connectionId, {
    accessToken: "quota-token",
  });

  // Use 100% (fully exhausted) to avoid floating-point boundary issues:
  // (1 - 0.98) * 100 = 2.0000000000000018, which is > DEFAULT_MIN_REMAINING_PERCENT (2),
  // so the preflight wouldn't block. 100% used → 0% remaining, clearly below 2%.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 100, reset_after_seconds: 90 },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  const preflight = await preflightQuota("codex", connectionId, {
    providerSpecificData: { quotaPreflightEnabled: true },
  });

  touchSession("session-codex", connectionId);
  startQuotaMonitor("session-codex", "codex", connectionId, {
    providerSpecificData: { quotaMonitorEnabled: true },
  });

  assert.equal(preflight.proceed, false);
  assert.equal(preflight.reason, "quota_exhausted");
  assert.equal(getActiveMonitorCount(), 1);

  stopQuotaMonitor("session-codex");
  assert.equal(getActiveMonitorCount(), 0);
});
