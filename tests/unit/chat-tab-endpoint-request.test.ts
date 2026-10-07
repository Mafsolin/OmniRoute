import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResponsesRequestBody,
  formatNonChatResponse,
} from "../../src/app/(dashboard)/dashboard/playground/components/tabs/chatTabEndpointRequest.ts";

const messages = [{ role: "user", content: "hi" }];
const base = { max_tokens: 0, temperature: 1 };
const OFF = { show: false, effortOptions: [] as string[] };

test("non-chat JSON cannot break out of its markdown fence", () => {
  const rendered = formatNonChatResponse(JSON.stringify({ note: "```\n# heading" }));
  const fence = rendered.match(/^`+/)?.[0] ?? "";
  assert.ok(fence.length >= 4, "fence must be longer than any backtick run inside the body");
  const inner = rendered.slice(fence.length + 1, -(fence.length + 1));
  assert.ok(!inner.includes(fence), "body must not contain its own closing fence");
  assert.match(rendered, /"note"/);
});

test("plain JSON keeps the conventional json fence", () => {
  const rendered = formatNonChatResponse(JSON.stringify({ ok: true }));
  assert.equal(rendered, "```json\n" + JSON.stringify({ ok: true }, null, 2) + "\n```");
});

test("Responses request forwards gated effort and thinking", () => {
  const body = buildResponsesRequestBody(messages, "m", base,
    { effort: "high", thinking: true }, { show: true, effortOptions: ["low", "high"] });
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.equal(body.thinking, true);
});

test("Responses request omits reasoning the spec did not allow", () => {
  const hidden = buildResponsesRequestBody(messages, "m", base,
    { effort: "high", thinking: true }, OFF);
  assert.equal(hidden.reasoning, undefined);
  assert.equal(hidden.thinking, undefined);
  const notOffered = buildResponsesRequestBody(messages, "m", base,
    { effort: "high" }, { show: true, effortOptions: ["low", "medium"] });
  assert.equal(notOffered.reasoning, undefined);
});
