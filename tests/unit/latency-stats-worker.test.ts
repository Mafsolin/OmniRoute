import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-latency-worker-"));
process.env.DATA_DIR = dir;
const core = await import("../../src/lib/db/core.ts");
const { getModelLatencyStats } = await import("../../src/lib/usage/usageHistory.ts");
const { createLatencyBucket, accumulateLatencySample, buildLatencyStatsEntry } =
  await import("../../src/lib/usage/usageHistory/helpers.ts");

test.after(async () => {
  const { closeUsageStatsReaderForTest } = await import("../../src/lib/usage/usageStatsReader.ts");
  await closeUsageStatsReaderForTest();
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("latency SELECT yields to the serving event loop and preserves scoped legacy results", async () => {
  const db = core.getDbInstance();
  const insert = db.prepare(`INSERT INTO usage_history
    (provider, model, success, latency_ms, ttft_ms, tokens_output, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const now = Date.now();
  db.transaction(() => {
    for (let i = 0; i < 6000; i++) {
      insert.run(
        i % 2 ? "p-other" : "p",
        i % 3 ? "m" : "m-other",
        i % 5 ? 1 : 0,
        1000 + i,
        100,
        20 + i,
        new Date(now - i * 1000).toISOString()
      );
    }
    insert.run("p", "m", 1, 100, 10, 1, new Date(now - 7200000).toISOString());
  })();
  const rows = db
    .prepare(
      `SELECT provider, model, success, latency_ms, ttft_ms, tokens_output
    FROM usage_history WHERE timestamp >= @sinceIso AND provider = @provider AND model = @model
    ORDER BY timestamp DESC LIMIT @maxRows`
    )
    .all({
      sinceIso: new Date(now - 3600000).toISOString(),
      provider: "p",
      model: "m",
      maxRows: 800,
    }) as Array<{ success: number; latency_ms: number; ttft_ms: number; tokens_output: number }>;
  const bucket = createLatencyBucket("p", "m");
  for (const row of rows) {
    bucket.totalRequests++;
    if (row.success) bucket.successfulRequests++;
    accumulateLatencySample(bucket, row.latency_ms, row.ttft_ms, row.tokens_output, !!row.success);
  }
  const expected = buildLatencyStatsEntry("p/m", bucket, 2, 1);
  assert.ok(expected);
  assert.equal(rows.length, 800);
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
  }, 0);
  try {
    const result = await getModelLatencyStats({
      windowHours: 1,
      provider: "p",
      model: "m",
      maxRows: 800,
      minSamples: 2,
    });
    assert.equal(
      timerFired,
      true,
      "latency SELECT completed before the serving-thread timer; SQL must run in the worker"
    );
    assert.deepEqual(result, { "p/m": expected });
  } finally {
    clearTimeout(timer);
  }
});

test("latency and dashboard aggregation share the singleton and never fall back after reader failure", async () => {
  const { getUsageStatsReader } = await import("../../src/lib/usage/usageStatsReader.ts");
  const { getUsageStats } = await import("../../src/lib/usage/usageStats.ts");
  const reader = getUsageStatsReader();
  assert.equal(getUsageStatsReader(), reader);
  const workerReads = mock.method(reader, "all");
  const servingReads = mock.method(core.getDbInstance(), "prepare");
  try {
    await getModelLatencyStats({ windowHours: 1, provider: "p", model: "m", maxRows: 2 });
    const stats = await getUsageStats();
    assert.equal(stats.totalRequests, 6001);
    assert.equal(
      workerReads.mock.calls.length,
      5,
      "latency SELECT and all four dashboard SELECTs use the same reader"
    );
    assert.ok(
      workerReads.mock.calls.some((call) => String(call.arguments[0]).includes("LIMIT @maxRows"))
    );
    const heavyServingQueries = () =>
      servingReads.mock.calls.filter((call) =>
        /FROM usage_history/i.test(String(call.arguments[0]))
      );
    assert.equal(heavyServingQueries().length, 0);
    await reader.close();
    await assert.rejects(() => getModelLatencyStats({ provider: "p" }), /reader is closed/);
    await assert.rejects(() => getUsageStats(), /reader is closed/);
    assert.equal(
      heavyServingQueries().length,
      0,
      "worker failure must not resurrect synchronous SQL"
    );
  } finally {
    workerReads.mock.restore();
    servingReads.mock.restore();
    const { closeUsageStatsReaderForTest } =
      await import("../../src/lib/usage/usageStatsReader.ts");
    await closeUsageStatsReaderForTest();
  }
});

test("provider and model scopes stay parameterized in the shared worker", async () => {
  assert.deepEqual(await getModelLatencyStats({ provider: "p' OR 1=1 --", model: "m" }), {});
  assert.deepEqual(await getModelLatencyStats({ provider: "p", model: "m' OR 1=1 --" }), {});
});
