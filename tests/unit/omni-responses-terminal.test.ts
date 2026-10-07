import test from "node:test";
import assert from "node:assert/strict";
import { consumeChatStream } from "../../src/lib/playground/consumeChatStream.ts";
const enc = new TextEncoder();
const frame = (type: string, fields: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const body = (payload: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(payload)); c.close(); } });

test("response.incomplete is terminal and maps max_output_tokens to length", async () => {
  let text = "";
  const result = await consumeChatStream(body(
    frame("response.output_text.delta", { delta: "partial" }) +
    frame("response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })
  ), { onText: s => { text += s; } });
  assert.equal(text, "partial");
  assert.equal(result.finishReason, "length");
});

test("response.incomplete content_filter maps to content_filter", async () => {
  const result = await consumeChatStream(body(
    frame("response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } })
  ));
  assert.equal(result.finishReason, "content_filter");
});

test("response.failed surfaces the upstream error and keeps partial text", async () => {
  let text = "";
  await assert.rejects(consumeChatStream(body(
    frame("response.output_text.delta", { delta: "partial" }) +
    frame("response.failed", { response: { status: "failed", error: { message: "synthetic failure" } } })
  ), { onText: s => { text += s; } }), /synthetic failure/);
  assert.equal(text, "partial");
});
