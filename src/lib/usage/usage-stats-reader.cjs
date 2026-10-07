"use strict";
const { Worker } = require("node:worker_threads");
const path = require("node:path");
// Inline source stays valid when Next/Webpack bundles this module.
const workerSource = `
  const { parentPort, workerData } = require('node:worker_threads');
  const req = require('node:module').createRequire(workerData.resolveFrom);
  const Database = req('better-sqlite3');
  const db = new Database(workerData.file, { readonly: true, fileMustExist: true, timeout: 5000 });
  db.pragma('query_only = ON');
  db.pragma('cache_size = -16384');
  const statements = new Map();
  parentPort.on('message', ({ id, sql, params }) => {
    try {
      let statement = statements.get(sql);
      if (!statement) {
        if (statements.size >= 32) statements.delete(statements.keys().next().value);
        statement = db.prepare(sql);
        statements.set(sql, statement);
      }
      parentPort.postMessage({ id, rows: statement.all(...params) });
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
`;
function createUsageStatsReader(file) {
  let worker = null,
    seq = 0,
    closed = false;
  const pending = new Map();
  const inflight = new Map();
  const cache = new Map();
  function start() {
    if (worker) return worker;
    const current = new Worker(workerSource, {
      eval: true,
      workerData: { file, resolveFrom: path.join(process.cwd(), "package.json") },
    });
    worker = current;
    const fail = (error) => {
      if (worker !== current) return;
      worker = null;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
      inflight.clear();
      cache.clear();
    };
    current.on("message", (message) => {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (!pending.size) current.unref();
      message.error ? item.reject(new Error(message.error)) : item.resolve(message.rows);
    });
    current.on("error", fail);
    current.on("exit", (code) => fail(new Error("Usage SQL worker exited: " + code)));
    current.unref();
    return current;
  }
  async function all(sql, params = []) {
    if (closed) throw new Error("Usage SQL reader is closed");
    const key = sql + "\0" + JSON.stringify(params);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.rows;
    if (inflight.has(key)) return inflight.get(key);
    if (pending.size >= 32) throw new Error("Usage SQL queue is full");
    const current = start();
    current.ref();
    const promise = new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        // A queued callback from a terminated generation must not drain
        // pending requests belonging to its replacement.
        if (worker !== current || !pending.has(id)) return;
        worker = null;
        current.terminate();
        const error = new Error("Usage SQL query timed out");
        for (const item of pending.values()) {
          clearTimeout(item.timer);
          item.reject(error);
        }
        pending.clear();
        inflight.clear();
        cache.clear();
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      try {
        current.postMessage({ id, sql, params });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        if (!pending.size) current.unref();
        reject(error);
      }
    });
    inflight.set(key, promise);
    try {
      const rows = await promise;
      // A message may resolve just before fail()/close() invalidates this
      // generation. Do not let its queued continuation restore stale rows.
      if (!closed && worker === current) {
        if (cache.size >= 16) cache.delete(cache.keys().next().value);
        cache.set(key, { rows, expires: Date.now() + 5000 });
      }
      return rows;
    } finally {
      if (inflight.get(key) === promise) inflight.delete(key);
    }
  }
  async function close() {
    closed = true;
    const current = worker;
    worker = null;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Usage SQL reader closed"));
    }
    pending.clear();
    inflight.clear();
    cache.clear();
    if (current) await current.terminate();
  }
  return { all, close };
}
module.exports = { createUsageStatsReader };
