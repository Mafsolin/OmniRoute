import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveResponsesWsCallLogId,
  resolveResponsesWsTtftMs,
} from "../../src/app/api/internal/codex-responses-ws/history.ts";

test("Responses WebSocket history prefers the logical-turn id over the socket session id", () => {
  assert.equal(
    resolveResponsesWsCallLogId({
      sessionId: "socket-session",
      callLogId: "logical-turn-2",
    }),
    "logical-turn-2"
  );
});

test("Responses WebSocket history keeps the session fallback for rolling deploy compatibility", () => {
  assert.equal(resolveResponsesWsCallLogId({ sessionId: "legacy-session" }), "legacy-session");
  assert.equal(resolveResponsesWsCallLogId({}), undefined);
});

test("Responses WebSocket history accepts measured TTFT and bounds malformed values", () => {
  assert.equal(resolveResponsesWsTtftMs({ ttftMs: 120 }, 500), 120);
  assert.equal(resolveResponsesWsTtftMs({}, 500), 500);
  assert.equal(resolveResponsesWsTtftMs({ ttftMs: 900 }, 500), 500);
  assert.equal(resolveResponsesWsTtftMs({ ttftMs: -10 }, 500), 0);
  assert.equal(resolveResponsesWsTtftMs({ ttftMs: "not-a-number" }, 500), 500);
});
