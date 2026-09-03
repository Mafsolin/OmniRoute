/**
 * tests/unit/stream-ttft-scaffolding.test.ts
 *
 * TTFT must measure the model's first real token, not the protocol
 * scaffolding the proxy forwards within milliseconds of the request.
 *
 * Live-traffic evidence (production DB, 2026-09-03): 896 usage_history rows in
 * a single day carried ttft_ms < 100 against latency_ms > 2000 — e.g. 10ms TTFT
 * on a 12.6s Codex /v1/responses stream. The cause was `forward()` marking TTFT
 * on EVERY enqueued frame, so `response.created` (emitted by the upstream
 * before any generation) set TTFT. That also corrupts the decode-rate/TPS
 * derivation, which divides output tokens by `latency - ttft`.
 *
 * These tests drive the REAL streaming transform end to end and assert on the
 * `ttft` handed to the onComplete callback — the exact value persisted to
 * usage_history.ttft_ms.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ttft-scaffold-"));
const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.ts");

const encoder = new TextEncoder();
const SCAFFOLD_TO_TOKEN_DELAY_MS = 60;

/** Emit `response.created` immediately, then a real token after a delay. */
function upstreamWithDelayedFirstToken(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      // Scaffolding: carries no generated output.
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp_ttft", status: "in_progress" },
          })}\n\n`
        )
      );
      // The model "thinks" before producing its first token.
      await new Promise((r) => setTimeout(r, SCAFFOLD_TO_TOKEN_DELAY_MS));
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            sequence_number: 1,
            item_id: "msg_1",
            output_index: 0,
            delta: "pong",
          })}\n\n`
        )
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "response.completed",
            sequence_number: 2,
            response: {
              id: "resp_ttft",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "pong" }],
                },
              ],
              usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
            },
          })}\n\n`
        )
      );
      controller.close();
    },
  });
}

async function runPassthrough(source: ReadableStream<Uint8Array>) {
  let completed: { ttft?: number; itlMs?: number } | null = null;
  const transform = createPassthroughStreamWithLogger(
    "codex",
    null,
    null,
    "gpt-5.6-luna",
    null,
    { input: [{ role: "user", content: "ping" }] },
    (payload) => {
      completed = payload as { ttft?: number; itlMs?: number };
    }
  );
  const text = await new Response(source.pipeThrough(transform)).text();
  return { text, completed };
}

test("TTFT skips `response.created` scaffolding and measures the first token", async () => {
  const { text, completed } = await runPassthrough(upstreamWithDelayedFirstToken());

  // Precondition: the scaffolding really was forwarded to the client, so a
  // first-forward-based TTFT would have latched on it.
  assert.match(text, /response\.created/, "scaffolding must still reach the client");
  assert.match(text, /"delta":"pong"/, "the generated token must reach the client");

  assert.ok(completed, "onComplete must fire");
  const ttft = Number(completed!.ttft);
  assert.ok(Number.isFinite(ttft), `ttft must be a number, got ${completed!.ttft}`);

  // The regression: TTFT used to be ~0-5ms here (the response.created frame).
  // Allow scheduler slack but require it to reflect the real wait.
  assert.ok(
    ttft >= SCAFFOLD_TO_TOKEN_DELAY_MS - 15,
    `ttft must measure the first generated token (>=~${SCAFFOLD_TO_TOKEN_DELAY_MS}ms), got ${ttft}ms — ` +
      "this is the #12135-adjacent defect where response.created set TTFT"
  );
});

test("TTFT stays below total latency so the decode interval is positive", async () => {
  const startedAt = Date.now();
  const { completed } = await runPassthrough(upstreamWithDelayedFirstToken());
  const totalMs = Date.now() - startedAt;

  const ttft = Number(completed!.ttft);
  // usageHistory helpers derive TPS from (latencyMs - ttftMs); a TTFT equal to
  // or above latency silently drops the row from the TPS aggregate.
  assert.ok(ttft <= totalMs, `ttft (${ttft}ms) must not exceed total latency (${totalMs}ms)`);
  assert.ok(ttft > 0, `ttft must be positive, got ${ttft}`);
});
