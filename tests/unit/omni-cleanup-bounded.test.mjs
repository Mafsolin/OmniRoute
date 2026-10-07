import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

for (const mode of [0, 2]) {
  test(`actual SQLite mode ${mode}: startup reclamation is truthful and bounded`, async () => {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-vacuum-"));
    const db = new Database(path.join(directory, "fixture.sqlite"));
    try {
      db.pragma(`auto_vacuum = ${mode}`);
      db.exec("CREATE TABLE fixture (value BLOB)");
      const insert = db.prepare("INSERT INTO fixture VALUES (zeroblob(3000))");
      db.transaction(() => { for (let i = 0; i < 700; i++) insert.run(); })();
      db.exec("DELETE FROM fixture");
      const beforePages = db.pragma("page_count", { simple: true });
      const beforeFree = db.pragma("freelist_count", { simple: true });
      assert.ok(beforeFree > 256, "fixture must contain enough free pages to test the bound");
      const source = fs.readFileSync(new URL("../../src/lib/db/cleanup.ts", import.meta.url), "utf8");
      const begin = source.indexOf("export function startCleanupScheduler(): void {");
      const end = source.indexOf("/**\n * Stop the background cleanup scheduler", begin);
      const code = source.slice(begin, end)
        .replace("export function startCleanupScheduler(): void", "function startCleanupScheduler()")
        .replace(": ReturnType<typeof getDbInstance>, label: string): void =>", ", label) =>");
      const callbacks = [];
      const logs = [];
      const context = vm.createContext({
        _cleanupSchedulerTimer: null, CLEANUP_INTERVAL_MS: 21600000,
        console: { log: (line) => logs.push(line), error: (line) => { throw new Error(line); } },
        setTimeout: (callback) => { callbacks.push(callback); return 1; },
        setInterval: () => ({ unref() {} }),
        runAutoCleanup: async () => ({ totalDeleted: 700 }),
        cleanupProxyLogs: async () => ({ deleted: 0 }),
        getDbInstance: () => db,
      });
      vm.runInContext(code + ";startCleanupScheduler();", context);
      await callbacks[0]();
      const afterPages = db.pragma("page_count", { simple: true });
      const afterFree = db.pragma("freelist_count", { simple: true });
      if (mode === 0) {
        assert.equal(afterPages, beforePages);
        assert.equal(afterFree, beforeFree);
        assert.ok(logs.some((line) => line.includes("Skipping bounded")));
        assert.ok(!logs.some((line) => line.includes("reclamation completed")));
      } else {
        assert.ok(afterPages < beforePages, "real incremental SQLite must reclaim free pages");
        assert.ok(beforePages - afterPages <= 256, "at most 256 pages are reclaimed per cleanup");
        assert.ok(logs.some((line) => line.includes("reclamation completed")));
      }
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
test("retention cleanup reclaims bounded pages without full VACUUM in the request event loop", async () => {
  const source = fs.readFileSync(new URL("../../src/lib/db/cleanup.ts", import.meta.url), "utf8");
  const begin = source.indexOf("export function startCleanupScheduler(): void {");
  const end = source.indexOf("/**\n * Stop the background cleanup scheduler", begin);
  let code = source
    .slice(begin, end)
    .replace("export function startCleanupScheduler(): void", "function startCleanupScheduler()")
    .replace(": ReturnType<typeof getDbInstance>, label: string): void =>", ", label) =>");
  const calls = [];
  const callbacks = [];
  const context = {
    _cleanupSchedulerTimer: null,
    CLEANUP_INTERVAL_MS: 21600000,
    console: { log() {}, error() {} },
    setTimeout(f) {
      callbacks.push(f);
      return 1;
    },
    setInterval(f) {
      callbacks.push(f);
      return { unref() {} };
    },
    runAutoCleanup: async () => ({ totalDeleted: 3 }),
    cleanupProxyLogs: async () => ({ deleted: 0 }),
    getDbInstance: () => ({ exec: (s) => calls.push(s), pragma: (s) => { calls.push(s); return s === "auto_vacuum" ? 2 : undefined; } }),
  };
  vm.createContext(context);
  vm.runInContext(code + ";startCleanupScheduler();", context);
  for (const f of callbacks) await f();
  assert.equal(
    calls.some((x) => /^VACUUM$/i.test(x)),
    false,
    `full VACUUM calls: ${calls.join(", ")}`
  );
  assert.equal(
    calls.filter((x) => x === "incremental_vacuum(256)").length,
    2,
    "both startup and periodic cleanup should use bounded incremental reclamation"
  );
});
test('cleanup does not claim reclamation when SQLite auto_vacuum is NONE', async () => {
  const source = fs.readFileSync(new URL('../../src/lib/db/cleanup.ts', import.meta.url), 'utf8');
  const begin = source.indexOf('export function startCleanupScheduler(): void {');
  const end = source.indexOf('/**\n * Stop the background cleanup scheduler', begin);
  const code = source.slice(begin, end).replace('export function startCleanupScheduler(): void', 'function startCleanupScheduler()').replace(': ReturnType<typeof getDbInstance>, label: string): void =>', ', label) =>');
  const calls = []; const callbacks = [];
  const context = {
    _cleanupSchedulerTimer: null, CLEANUP_INTERVAL_MS: 21600000,
    console: { log() {}, error() {} },
    setTimeout(f) { callbacks.push(f); return 1; },
    setInterval(f) { callbacks.push(f); return { unref() {} }; },
    runAutoCleanup: async () => ({ totalDeleted: 3 }),
    cleanupProxyLogs: async () => ({ deleted: 0 }),
    getDbInstance: () => ({ pragma: (s) => { calls.push(s); return s === 'auto_vacuum' ? 0 : undefined; } }),
  };
  vm.createContext(context); vm.runInContext(code + ';startCleanupScheduler();', context);
  for (const f of callbacks) await f();
  assert.equal(calls.filter((x) => x === 'incremental_vacuum(256)').length, 0);
  assert.equal(calls.filter((x) => x === 'auto_vacuum').length, 2, 'startup and periodic cleanup must check the SQLite reclamation mode');
});
