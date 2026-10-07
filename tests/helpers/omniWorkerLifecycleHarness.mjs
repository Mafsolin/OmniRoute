// Deterministic lifecycle scheduling only. Real SQLite/worker behavior is
// exercised separately by omni-worker-read; a fake Worker lets these tests
// deliver obsolete callbacks that cannot be reliably forced with a real thread.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { EventEmitter } from "node:events";
export function workerLifecycleHarness(options = {}) {
  const workers = [],
    timers = [];
  class ControlledWorker extends EventEmitter {
    messages = [];
    constructor() {
      super();
      workers.push(this);
    }
    refs = 0;
    unrefs = 0;
    ref() { this.refs++; }
    unref() { this.unrefs++; }
    postMessage(message) {
      this.messages.push(message);
      if (options.postMessageError) throw options.postMessageError;
    }
    terminate() {
      return Promise.resolve(0);
    }
    respond(rows) {
      this.emit("message", { id: this.messages.at(-1).id, rows });
    }
  }
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    process,
    require: (name) => (name === "node:worker_threads" ? { Worker: ControlledWorker } : path),
    setTimeout(callback, ms) {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
  });
  const file = new URL("../../src/lib/usage/usage-stats-reader.cjs", import.meta.url);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file.pathname });
  return { reader: module.exports.createUsageStatsReader("test-fixture.sqlite"), workers, timers };
}
