/**
 * OpenCode Zen free-tier harness gate — the BODY half.
 *
 * opencode.ai refuses its `-free` models to any caller that does not look like the
 * OpenCode CLI itself, answering
 *   403 FreeTierError "OpenCode's free tier can only be used from within OpenCode".
 * The check has two independent halves and both must pass.
 *
 *  - Header half (owned by `opencodeHeaders.ts` / OpencodeExecutor): a `User-Agent`
 *    carrying the versioned `opencode/<version>` token, plus `x-opencode-client` and
 *    `x-opencode-session`. Live bisection 2026-09-22: the bare `opencode` string the
 *    executor used to default to is NOT accepted — only `opencode/1.18.31` passes.
 *  - Body half (this module): a body that looks like an agent turn.
 *
 * Body requirements, measured live against the gate on 2026-09-22:
 *
 *  - `stream: true` is mandatory. A non-streaming body is refused by policy, so the
 *    free route is always forced to stream upstream and `chatCore` converts the SSE
 *    back to JSON for `stream: false` callers (same path as `forceStream` providers).
 *  - the body must carry core tool NAMES. The widely repeated claim that any two of
 *    `bash`/`read`/`edit`/`glob`/`grep` qualify is WRONG: across all ten pairs, only
 *    `bash` + `read` returns 200 (`glob`+`grep`, `bash`+`terminal`, `read`+`edit`, …
 *    all still 403). Only the names are read — schemas and descriptions are ignored —
 *    which is why bare stubs are enough.
 *  - no `Authorization` header is required for the free tier at all; the gate is an
 *    identity check, not an auth check.
 *
 * The stubs are never registered with any client, so a model that actually calls one
 * receives an ordinary "unknown tool" error and recovers on the next turn.
 */

/** Core tool names the gate counts. Only this exact pair was verified to pass. */
export const ZEN_GATE_TOOL_NAMES = ["bash", "read"] as const;

const ZEN_GATE_STUB_DESCRIPTION =
  "Gateway-validation stub, NOT IMPLEMENTED. Never call this tool: every call fails. " +
  "Use a real registered tool instead.";

const ZEN_GATE_STUB_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command to execute" },
  },
  required: ["command"],
  additionalProperties: false,
};

/** Providers whose free tier is gated by the OpenCode harness check. */
const ZEN_GATE_PROVIDERS = new Set(["opencode", "opencode-zen"]);

/**
 * True when the request targets a gated OpenCode free-tier model.
 *
 * Deliberately scoped to the `-free` suffix: paid models on the same provider are not
 * gated and must keep their request body byte-identical to before. `opencode-go` is
 * excluded outright — it has no free tier.
 */
export function isZenGatedFreeModel(
  provider: string | null | undefined,
  model: string | null | undefined
): boolean {
  if (!provider || !ZEN_GATE_PROVIDERS.has(provider)) return false;
  return String(model || "").endsWith("-free");
}

/** Tool name in either the chat-completions or the Responses envelope. */
function zenGateToolName(tool: unknown): string | null {
  if (!tool || typeof tool !== "object") return null;
  const record = tool as Record<string, unknown>;
  if (typeof record.name === "string") return record.name; // Responses API
  const fn = record.function as Record<string, unknown> | undefined; // chat completions
  return fn && typeof fn.name === "string" ? fn.name : null;
}

/** A stub in the envelope the body is already using. */
function zenGateStub(name: string, responsesShape: boolean): Record<string, unknown> {
  if (responsesShape) {
    return {
      type: "function",
      name,
      description: ZEN_GATE_STUB_DESCRIPTION,
      parameters: ZEN_GATE_STUB_PARAMETERS,
    };
  }
  return {
    type: "function",
    function: {
      name,
      description: ZEN_GATE_STUB_DESCRIPTION,
      parameters: ZEN_GATE_STUB_PARAMETERS,
    },
  };
}

/**
 * True when the request forces a tool call, so an injected stub would be invoked for
 * sure. Such bodies are left alone rather than poisoned with a callable-by-mandate stub.
 */
function isForcedToolChoice(choice: unknown): boolean {
  if (choice === "required" || choice === "any") return true;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const type = (choice as Record<string, unknown>).type;
    return type === "required" || type === "any";
  }
  return false;
}

/**
 * Append stubs for whichever of `ZEN_GATE_TOOL_NAMES` the body is missing. Bodies that
 * already carry enough core names are returned unchanged.
 */
export function withZenGateToolStubs<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const tools = Array.isArray(record.tools) ? (record.tools as unknown[]) : null;
  const present = new Set(
    (tools ?? []).map(zenGateToolName).filter((name): name is string => name !== null)
  );
  const missing = ZEN_GATE_TOOL_NAMES.filter((name) => !present.has(name));
  if (missing.length === 0) return body;
  if (isForcedToolChoice(record.tool_choice)) return body;
  // Responses bodies carry `input` and no `messages`; chat-completions bodies the reverse.
  const responsesShape = !Array.isArray(record.messages) && Array.isArray(record.input);
  const stubs = missing.map((name) => zenGateStub(name, responsesShape));
  return { ...record, tools: tools ? [...tools, ...stubs] : stubs } as T;
}
