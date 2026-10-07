import test from "node:test";
import assert from "node:assert/strict";
import { getReasoningTokensOrNull } from "../../src/lib/usage/tokenAccounting.ts";
test("Responses output details preserve nullable reasoning counts without changing billing helpers", () => {
  assert.equal(getReasoningTokensOrNull({ output_tokens_details: { reasoning_tokens: 3 } }), 3);
  assert.equal(getReasoningTokensOrNull({ output_tokens_details: { reasoning_tokens: 0 } }), 0);
  assert.equal(getReasoningTokensOrNull({ output_tokens: 11 }), null);
});
