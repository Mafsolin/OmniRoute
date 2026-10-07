import test from "node:test";
import assert from "node:assert/strict";
import { consumeChatStream } from "../../src/lib/playground/consumeChatStream.ts";
const enc = new TextEncoder();
const event = (j: unknown) => `data: ${JSON.stringify(j)}\n\n`;
function body(payload: string, cancel?: (reason: unknown) => void, close = true) {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(payload)); if (close) c.close(); }, cancel });
}

test("clean EOF without terminal is truncation, not successful delivery", async () => {
  let text = "";
  await assert.rejects(consumeChatStream(body(event({ choices: [{ delta: { content: "partial" } }] })), { onText: s => { text += s; } }), /stream_truncated/);
  assert.equal(text, "partial");
});
test("DONE cancels still-open transport and ignores output after terminal", async () => {
  let cancelled = false;
  let text = "";
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(event({ choices: [{ delta: { content: "answer" } }] }) + "data: [DONE]\n\n" + event({ choices: [{ delta: { content: "LATE" } }] })));
      setTimeout(() => { if (!cancelled) c.close(); }, 30);
    },
    cancel() { cancelled = true; },
  });
  await consumeChatStream(stream, { onText: s => { text += s; } });
  assert.equal(text, "answer");
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});
test("reasoning-only length is observable without a fabricated answer", async () => {
  let reasoning = "";
  const result = await consumeChatStream(body(event({ choices: [{ delta: { reasoning_content: "thinking" } }] }) + event({ choices: [{ delta: {}, finish_reason: "length" }] }) + "data: [DONE]\n\n"), { onReasoning: s => { reasoning += s; } });
  assert.equal(reasoning, "thinking");
  assert.equal(result.hasReasoning, true);
  assert.equal(result.hasText, false);
  assert.equal(result.finishReason, "length");
});
test("abort cancels an otherwise open body, releases its reader and preserves partial text", async () => {
  const controller = new AbortController();
  let cancelled = false; let text = "";
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(event({ choices: [{ delta: { content: "partial" } }] }))); setTimeout(() => controller.abort(), 5); setTimeout(() => { if (!cancelled) { c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }, 30); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(consumeChatStream(stream, { onText: s => { text += s; } }, controller.signal), { name: "AbortError" });
  assert.equal(text, "partial"); assert.equal(cancelled, true); assert.equal(stream.locked, false);
});
