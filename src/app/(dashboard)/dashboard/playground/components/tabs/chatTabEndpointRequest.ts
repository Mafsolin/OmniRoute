// src/app/(dashboard)/dashboard/playground/components/tabs/chatTabEndpointRequest.ts
//
// #10592 — ChatTab.tsx hardcoded every "Send" click to POST /api/v1/chat/completions,
// ignoring configState.endpoint entirely. Selecting a search-only provider (exa-search,
// tavily-search, serper-search) in the Endpoint selector still sent a chat.completions
// request, which has no notion of search-provider credentials and 404s.
//
// This module gives ChatTab a small, testable seam for routing non-chat endpoints
// (currently "search" and "web.fetch") to their real path with a query-shaped body,
// instead of the chat.completions messages/SSE shape.

import { endpointToPath, type PlaygroundEndpoint } from "@/lib/playground/codeExport";
import { buildReasoningRequestFields, type ReasoningControlSpec } from "../reasoningControlUtils";

/** Chat-shaped endpoints keep the existing messages[] + SSE-delta request/response flow. */
export function isChatCompletionsEndpoint(endpoint: PlaygroundEndpoint | undefined): boolean {
  return !endpoint || endpoint === "chat.completions";
}

/** Resolves the fetch path (mounted under `/api`) for the selected Playground endpoint. */
export function resolveChatTabRequestPath(endpoint: PlaygroundEndpoint | undefined): string {
  return `/api${endpointToPath(endpoint ?? "chat.completions")}`;
}

/**
 * Builds the request body for a non-chat endpoint from the user's free-text query.
 * "search" and "web.fetch" both take a single string field instead of a messages array.
 */
export function buildNonChatRequestBody(
  endpoint: PlaygroundEndpoint | undefined,
  query: string,
  model: string
): Record<string, unknown> {
  if (endpoint === "web.fetch") {
    return { url: query };
  }
  const body: Record<string, unknown> = { query };
  if (model) body.model = model;
  return body;
}

/** Native Responses shape; Chat-only options are forwarded only through the shared reasoning gate. */
export function buildResponsesRequestBody(
  messages: Array<{ role: string; content: string }>,
  model: string,
  params: { max_tokens: number; temperature: number; top_p?: number; jsonMode?: boolean },
  reasoning: { effort?: string; thinking?: boolean } = {},
  spec: ReasoningControlSpec = { show: false, effortOptions: [] },
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, input: messages, stream: true };
  if (params.max_tokens > 0) body.max_output_tokens = params.max_tokens;
  if (params.temperature !== 1) body.temperature = params.temperature;
  if (params.top_p !== undefined && params.top_p !== 1) body.top_p = params.top_p;
  const gated = buildReasoningRequestFields(reasoning, spec);
  if (gated.effort) body.reasoning = { effort: gated.effort };
  if (gated.thinking) body.thinking = true;
  if (params.jsonMode) body.text = { format: { type: "json_object" } };
  return body;
}

/** Renders a non-chat endpoint's raw response text as a chat-bubble-friendly string. */
export function formatNonChatResponse(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    const body = JSON.stringify(parsed, null, 2);
    const backtickRuns: string[] = body.match(/`+/g) ?? [];
    const longestRun = backtickRuns.reduce((max: number, run: string) => Math.max(max, run.length), 0);
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return `${fence}json\n${body}\n${fence}`;
  } catch {
    return rawText;
  }
}

/** Finds the most recent user-authored message content to use as a non-chat query. */
export function lastUserContent(
  chatMessages: Array<{ role: string; content: string }>
): string {
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    if (chatMessages[i].role === "user") return chatMessages[i].content;
  }
  return "";
}
