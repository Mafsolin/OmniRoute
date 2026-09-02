import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCodexUsageQuotas } from "../../open-sse/services/codexUsageQuotas";
import { getCodexQuotaWindowFilterForModel } from "../../open-sse/config/codexQuotaScopes";

describe("Codex usage windows", () => {
  it("preserves upstream durations for session and weekly windows", () => {
    const { quotas } = buildCodexUsageQuotas({
      rate_limit: {
        primary_window: {
          used_percent: 7,
          limit_window_seconds: 18_000,
          reset_at: 1_785_623_016,
        },
        secondary_window: {
          used_percent: 19,
          limit_window_seconds: 604_800,
          reset_at: 1_785_678_428,
        },
      },
    });

    assert.deepEqual(quotas.session, {
      used: 7,
      total: 100,
      remaining: 93,
      resetAt: new Date(1_785_623_016_000).toISOString(),
      unlimited: false,
      windowSeconds: 18_000,
    });
    assert.deepEqual(quotas.weekly, {
      used: 19,
      total: 100,
      remaining: 81,
      resetAt: new Date(1_785_678_428_000).toISOString(),
      unlimited: false,
      windowSeconds: 604_800,
    });
  });

  it("accepts camelCase duration variants and nulls invalid values", () => {
    const { quotas } = buildCodexUsageQuotas({
      rateLimit: {
        primaryWindow: { usedPercent: 3, windowSeconds: "18000" },
        secondaryWindow: { usedPercent: 4, windowSeconds: "not-a-number" },
      },
    });

    assert.equal(quotas.session.windowSeconds, 18_000);
    assert.equal(quotas.weekly.windowSeconds, null);
  });

  it("surfaces the Luna reserve window from additional_rate_limits", () => {
    const { quotas } = buildCodexUsageQuotas({
      rate_limit: {
        primary_window: { used_percent: 100, reset_after_seconds: 60 },
      },
      additional_rate_limits: [
        {
          limit_name: "gpt-reserve",
          metered_feature: "base_model_inference",
          rate_limit: {
            primary_window: { used_percent: 12, reset_after_seconds: 900 },
          },
        },
      ],
    });

    assert.equal(quotas["gpt-reserve"]?.used, 12);
    assert.equal(quotas["gpt-reserve"]?.remaining, 88);
    assert.equal(quotas["gpt-reserve"]?.displayName, "Luna Reserve");
  });

  it("allows the reserve only for Luna model quota selection", () => {
    const lunaFilter = getCodexQuotaWindowFilterForModel("gpt-5.6-luna");
    const solFilter = getCodexQuotaWindowFilterForModel("gpt-5.6-sol");

    assert.equal(lunaFilter?.("gpt-reserve"), true);
    assert.equal(solFilter?.("gpt-reserve"), false);
    assert.equal(lunaFilter?.("session"), true);
    assert.equal(solFilter?.("session"), true);
  });

  it("keeps both reserve windows when the upstream reports primary and secondary", () => {
    const { quotas } = buildCodexUsageQuotas({
      additional_rate_limits: [
        {
          limit_name: "gpt-reserve",
          rate_limit: {
            primary_window: { used_percent: 12, reset_after_seconds: 900 },
            secondary_window: { used_percent: 4, reset_after_seconds: 3600 },
          },
        },
      ],
    });

    assert.equal(quotas["gpt-reserve"]?.used, 12);
    assert.equal(quotas["gpt-reserve_weekly"]?.used, 4);
  });
});
