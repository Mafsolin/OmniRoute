import test from "node:test";
import assert from "node:assert/strict";
import { fetchJsonWithDeadline as readJson } from "../../src/shared/utils/fetchJsonWithDeadline.ts";

test("JSON deadline includes the body when headers arrive and parsing never settles", async () => {
  let signal: AbortSignal | undefined;
  const fake = async (_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return { ok: true, json: () => new Promise(() => {}) };
  };
  let outer: ReturnType<typeof setTimeout>;
  const outcome = await Promise.race([
    readJson("/synthetic", { timeoutMs: 20, fetchFn: fake as unknown as typeof fetch })
      .then(() => "resolved", (error: Error) => error.name),
    new Promise<string>((resolve) => { outer = setTimeout(() => resolve("body still pending"), 80); }),
  ]);
  clearTimeout(outer!);
  assert.equal(outcome, "FetchJsonDeadlineError");
  assert.equal(signal?.aborted, true);
});

test("forwards request options and consumes valid JSON", async () => {
  let seen: RequestInit | undefined;
  const result = await readJson("/synthetic", { timeoutMs: 100, cache: "no-store", method: "POST",
    headers: { "x-fixture": "1" }, body: "fixture", fetchFn: (async (_url, init) => {
      seen = init;
      return new Response('{"ok":true}');
    }) as typeof fetch });
  assert.deepEqual(result, { ok: true });
  assert.equal(seen?.cache, "no-store");
  assert.equal(seen?.method, "POST");
  assert.equal(seen?.body, "fixture");
  assert.deepEqual(seen?.headers, { "x-fixture": "1" });
  assert.ok(seen?.signal instanceof AbortSignal);
});

test("HTTP errors and malformed JSON reject, never becoming empty data", async () => {
  await assert.rejects(readJson("/synthetic", { fetchFn: (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch }), /HTTP 401/);
  await assert.rejects(readJson("/synthetic", { fetchFn: (async () => new Response("not JSON")) as typeof fetch }), SyntaxError);
});

test("external abort bounds a pending non-cooperative JSON body and preserves abort reason", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Fixture unmounted", "AbortError");
  let requestSignal: AbortSignal | undefined;
  const pending = readJson("/synthetic", { signal: controller.signal, timeoutMs: 1000,
    fetchFn: (async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return { ok: true, json: () => new Promise(() => {}) };
    }) as unknown as typeof fetch });
  await Promise.resolve();
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(requestSignal?.aborted, true);
});

test("pre-abort never calls fetch and removes the caller listener after success", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let calls = 0;
  await assert.rejects(readJson("/synthetic", { signal: aborted.signal, fetchFn: (async () => {
    calls++; return new Response("{}");
  }) as typeof fetch }), (error: Error) => error.name === "AbortError");
  assert.equal(calls, 0);
  const controller = new AbortController();
  let removes = 0;
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => { removes++; remove(...args); };
  await readJson("/synthetic", { signal: controller.signal, fetchFn: (async () => new Response("{}")) as typeof fetch });
  assert.equal(removes, 1);
});
