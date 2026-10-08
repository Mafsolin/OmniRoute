// e2-profile.mjs — profile the cold catalog build on the stage via 127.0.0.1 inspector.
// Run AFTER the stage was (re)started with --inspect=127.0.0.1:9229 and healthz is up.
// The FIRST authorized GET /v1/models is the cold build; the profile lands in
// /var/lib/omniroute-maintenance/. The inspector never listens beyond loopback.
import { readFileSync, writeFileSync } from "node:fs";

const KEYFILE = "/opt/omniroute-quality-speed-data/e1/stage-key.txt";
const OUT = process.argv[2] || "/var/lib/omniroute-maintenance/catalog-20261008.cpuprofile";
const STAGE = "http://127.0.0.1:20138";
const INSPECT = "http://127.0.0.1:9229";

const key = readFileSync(KEYFILE, "utf8").trim();

const list = await (await fetch(INSPECT + "/json/list")).json();
const target = list.find((t) => t.webSocketDebuggerUrl);
if (!target) throw new Error("no inspector target on " + INSPECT);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((r) => (ws.onopen = r));

await call("Profiler.enable");
await call("Profiler.setSamplingInterval", { interval: 200 });
await call("Profiler.start");

const t0 = Date.now();
const res = await fetch(STAGE + "/v1/models", { headers: { Authorization: "Bearer " + key } });
const body = await res.text();
const t1 = Date.now();
console.log("models:", res.status, "bytes:", body.length, "ms:", t1 - t0);

const stopped = await call("Profiler.stop");
writeFileSync(OUT, JSON.stringify(stopped.result.profile));
console.log("profile saved:", OUT, "nodes:", stopped.result.profile.nodes.length);
ws.close();
process.exit(0);
