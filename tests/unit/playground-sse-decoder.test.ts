import test from "node:test";
import assert from "node:assert/strict";
import { SseDecoder } from "../../src/lib/playground/sseDecoder.ts";
const encode = new TextEncoder();

test("every byte split preserves UTF-8 and CRLF events", () => {
  const source = ': heartbeat\r\n\r\nevent: reply\r\ndata: {"text":"Ответ 🌿"}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = encode.encode(source);
  for (let split = 0; split <= bytes.length; split++) {
    const d = new SseDecoder();
    assert.deepEqual([...d.push(bytes.slice(0, split)), ...d.push(bytes.slice(split)), ...d.finish()], [
      { event: "reply", data: '{"text":"Ответ 🌿"}' }, { event: "message", data: "[DONE]" },
    ]);
  }
});
test("LF, bare CR, multiline data and comments", () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push(encode.encode('data: {\ndata: "ok":true}\n: comment\n\ndata: next\r\r')), [
    { event: "message", data: '{\n"ok":true}' },
  ]);
  assert.deepEqual(d.finish(), [{ event: "message", data: "next" }]);
});
test("unterminated frame is not silently accepted", () => {
  const d = new SseDecoder(); d.push(encode.encode('data: {"ok":true}'));
  assert.throws(() => d.finish(), /stream_truncated/);
});
test("oversized unfinished and multiline frames are bounded", () => {
  assert.throws(() => new SseDecoder(32).push(encode.encode("data: " + "x".repeat(33))), /limit exceeded/);
  assert.throws(() => new SseDecoder(32).push(encode.encode("data: " + "x".repeat(20) + "\ndata: " + "x".repeat(20) + "\n\n")), /limit exceeded/);
});
