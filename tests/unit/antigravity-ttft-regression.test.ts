import assert from "node:assert/strict";
import test from "node:test";

const { createSSETransformStreamWithLogger } = await import(
  "../../open-sse/utils/stream.ts"
);

const encoder = new TextEncoder();
const FIRST_CONTENT_DELAY_MS = 60;

function antigravityStreamWithDelayedContent(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      // First candidate opens the translated Responses stream but has no generated part.
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              responseId: "agy-ttft",
              modelVersion: "gemini-3.8-flash-tiered",
              candidates: [{ content: { role: "model", parts: [] } }],
            },
          })}\n\n`
        )
      );

      await new Promise((resolve) => setTimeout(resolve, FIRST_CONTENT_DELAY_MS));

      // This is the first real generated value.
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              responseId: "agy-ttft",
              modelVersion: "gemini-3.8-flash-tiered",
              candidates: [{ content: { role: "model", parts: [{ text: "pong" }] } }],
            },
          })}\n\n`
        )
      );

      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              responseId: "agy-ttft",
              modelVersion: "gemini-3.8-flash-tiered",
              candidates: [
                { content: { role: "model", parts: [] }, finishReason: "STOP" },
              ],
              usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 1,
                totalTokenCount: 6,
              },
            },
          })}\n\n`
        )
      );
      controller.close();
    },
  });
}

test("Antigravity translated Responses TTFT starts at the first generated event", async () => {
  let completed: { ttft?: number } | null = null;
  const transform = createSSETransformStreamWithLogger(
    "antigravity",
    "openai-responses",
    "antigravity",
    null,
    null,
    "gemini-3.8-flash-tiered",
    null,
    { input: [{ role: "user", content: "ping" }] },
    (payload) => {
      completed = payload as { ttft?: number };
    }
  );

  const output = await new Response(antigravityStreamWithDelayedContent().pipeThrough(transform)).text();
  assert.match(output, /response\.output_text\.delta/);
  assert.ok(completed, "stream completion callback must run");
  const ttft = Number(completed!.ttft);
  assert.ok(Number.isFinite(ttft), `expected numeric TTFT, got ${completed!.ttft}`);
  assert.ok(
    ttft >= FIRST_CONTENT_DELAY_MS - 15,
    `TTFT must exclude response scaffolding and include the model wait (got ${ttft}ms)`
  );
});
