import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sourceRoot, deploymentOptions } from "../helpers/omniPerformanceHarness.mjs";

async function exerciseReader(root, workerFile) {
  const req = createRequire(path.join(root, "package.json"));
  const DB = req("better-sqlite3");
  const { createUsageStatsReader } = req(workerFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-worker-test-"));
  const file = path.join(dir, "storage.sqlite");
  const db = new DB(file);
  db.exec(
    "CREATE TABLE usage_history(provider TEXT, tokens INTEGER); INSERT INTO usage_history VALUES ('test', 4), ('test', 6)"
  );
  // The worker resolves native dependencies from the serving process cwd.
  // For deployment this must be the explicitly selected candidate, not source.
  const cwd = process.cwd();
  process.chdir(root);
  let reader;
  try {
    reader = createUsageStatsReader(file);
    const sql = "SELECT provider, SUM(tokens) AS total FROM usage_history GROUP BY provider";
    assert.deepEqual(await reader.all(sql, []), db.prepare(sql).all());
    assert.deepEqual(
      await reader.all("SELECT @provider AS provider, @tokens AS tokens", [
        { provider: "p", tokens: 7 },
      ]),
      [{ provider: "p", tokens: 7 }]
    );
    assert.deepEqual(await reader.all("SELECT ? AS positional", [9]), [{ positional: 9 }]);
    let heartbeat = 0;
    const timer = setInterval(() => heartbeat++, 10);
    try {
      const [row] = await reader.all(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300000) SELECT SUM(x) AS total FROM n"
      );
      assert.equal(row.total, 45000150000);
      assert.ok(heartbeat >= 2, "event-loop heartbeat blocked while SQL executes");
    } finally {
      clearInterval(timer);
    }
    await assert.rejects(
      () => reader.all("DELETE FROM usage_history RETURNING *"),
      /readonly|read-only/i
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_history").get().n, 2);
    await reader.close();
    await assert.rejects(() => reader.all(sql), /reader is closed/);
  } finally {
    await reader?.close();
    db.close();
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("source: stats SQL runs read-only outside the serving event loop", () =>
  exerciseReader(
    sourceRoot,
    fileURLToPath(new URL("../../src/lib/usage/usage-stats-reader.cjs", import.meta.url))
  ));
test(
  "deployment: candidate worker and native SQLite dependencies are runnable",
  deploymentOptions,
  () => {
    assert.ok(process.env.OMNI_RUNTIME_DIR, "Release gate requires OMNI_RUNTIME_DIR");
    const root = path.resolve(process.env.OMNI_RUNTIME_DIR);
    return exerciseReader(root, path.join(root, "usage-stats-reader.cjs"));
  }
);

test("source: queue admits at most 32 unique queries and the 30s deadline rejects all pending work", async (t) => {
  const req = createRequire(path.join(sourceRoot, "package.json"));
  const DB = req("better-sqlite3");
  const { createUsageStatsReader } = req(
    fileURLToPath(new URL("../../src/lib/usage/usage-stats-reader.cjs", import.meta.url))
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-worker-bounds-"));
  const file = path.join(dir, "storage.sqlite");
  new DB(file).close();
  const cwd = process.cwd();
  process.chdir(sourceRoot);
  const reader = createUsageStatsReader(file);
  const callbacks = [];
  const setTimeoutReal = globalThis.setTimeout;
  const timers = t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    assert.equal(ms, 30000, "production deadline must remain bounded at 30 seconds");
    callbacks.push(callback);
    return setTimeoutReal(callback, ms, ...args);
  });
  try {
    const jobs = Array.from({ length: 32 }, (_, i) => reader.all("SELECT ? AS i", [i]));
    const settled = Promise.allSettled(jobs);
    await assert.rejects(() => reader.all("SELECT 33 AS i"), /queue is full/);
    assert.equal(callbacks.length, 32);
    // Fire the captured production deadline synchronously: no slow 30s sleep
    // and no mocked worker/SQLite. This tests the real rejection/termination path.
    callbacks[0]();
    const results = await settled;
    assert.ok(
      results.every(
        (result) => result.status === "rejected" && /timed out/.test(result.reason.message)
      )
    );
    timers.mock.restore();
    assert.deepEqual(
      await reader.all("SELECT 1 AS recovered"),
      [{ recovered: 1 }],
      "worker restarts after timeout"
    );
  } finally {
    timers.mock.restore();
    await reader.close();
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source: worker failure invalidates cached rows from the failed connection", async () => {
  const { workerLifecycleHarness } = await import("../helpers/omniWorkerLifecycleHarness.mjs");
  const { reader, workers } = workerLifecycleHarness();
  try {
    const first = reader.all("SELECT cached");
    workers[0].respond([{ value: 1 }]);
    await first;
    workers[0].emit("error", new Error("fixture worker failed"));
    const next = reader.all("SELECT cached");
    next.catch(() => {});
    assert.equal(workers.length, 2, "cached rows must not outlive a failed worker generation");
    workers[1].respond([{ value: 2 }]);
    assert.deepEqual(await next, [{ value: 2 }]);
  } finally {
    await reader.close();
  }
});

test("source: obsolete timeout and worker events cannot reject or evict the replacement generation", async () => {
  const { workerLifecycleHarness } = await import("../helpers/omniWorkerLifecycleHarness.mjs");
  const { reader, workers, timers } = workerLifecycleHarness();
  try {
    const old = reader.all("SELECT old");
    const oldResult = assert.rejects(old, /timed out/);
    timers[0].callback();
    await oldResult;
    const current = reader.all("SELECT current");
    current.catch(() => {});
    // Simulate a queued deadline delivered after its cancellation/termination.
    timers[0].callback();
    workers[0].emit("error", new Error("obsolete worker error"));
    workers[0].emit("exit", 1);
    workers[1].respond([{ value: 2 }]);
    assert.deepEqual(await current, [{ value: 2 }]);
    const cached = await reader.all("SELECT current");
    assert.deepEqual(cached, [{ value: 2 }]);
    assert.equal(
      workers[1].messages.length,
      1,
      "obsolete events must not discard replacement cache"
    );
  } finally {
    await reader.close();
  }
});

test("source: resolved rows from an obsolete generation cannot repopulate the cache", async () => {
  const { workerLifecycleHarness } = await import("../helpers/omniWorkerLifecycleHarness.mjs");
  const { reader, workers } = workerLifecycleHarness();
  try {
    const old = reader.all("SELECT cached");
    workers[0].respond([{ value: 1 }]);
    // Invalidate the connection before the awaiting all() continuation runs.
    workers[0].emit("error", new Error("fixture failure before cache write"));
    await old;
    const current = reader.all("SELECT cached");
    current.catch(() => {});
    assert.equal(
      workers.length,
      2,
      "obsolete successful continuation must not repopulate failed-generation cache"
    );
    workers[1].respond([{ value: 2 }]);
    assert.deepEqual(await current, [{ value: 2 }]);
  } finally {
    await reader.close();
  }
});
test('source: failed postMessage keeps other pending queries referenced and ignores its cleared deadline', async () => {
  const { workerLifecycleHarness } = await import('../helpers/omniWorkerLifecycleHarness.mjs');
  const options = {};
  const { reader, workers, timers } = workerLifecycleHarness(options);
  let healthy;
  try {
    healthy = reader.all('SELECT healthy');
    healthy.catch(() => {});
    options.postMessageError = new Error('DataCloneError: invalid second request');
    await assert.rejects(reader.all('SELECT invalid'), /DataCloneError/);
    assert.equal(timers[1].cleared, true);
    assert.equal(workers[0].unrefs, 1, 'worker must stay referenced while another request is pending');
    timers[1].callback();
    workers[0].emit('message', { id: workers[0].messages[0].id, rows: [{ value: 7 }] });
    assert.deepEqual(await healthy, [{ value: 7 }], 'obsolete failed-request deadline must not reject healthy work');
    assert.equal(workers[0].unrefs, 2, 'worker may be unreferenced once every pending request settles');
  } finally {
    await reader.close();
    await healthy?.catch(() => {});
  }
});

test('source: synchronous postMessage failure settles the request and clears its deadline', async () => {
  const { workerLifecycleHarness } = await import('../helpers/omniWorkerLifecycleHarness.mjs');
  const error = new Error('DataCloneError: fixture params cannot be cloned');
  const { reader, workers, timers } = workerLifecycleHarness({ postMessageError: error });
  try {
    const request = reader.all('SELECT clone');
    await assert.rejects(
      Promise.race([request, new Promise((_, reject) => setTimeout(() => reject(new Error('request did not settle')), 50))]),
      /DataCloneError/
    );
    assert.equal(timers.length, 1);
    assert.equal(timers[0].cleared, true);
    assert.equal(workers[0].unrefs, 2, 'failed postMessage must release the worker reference');
  } finally {
    await reader.close();
  }
});
