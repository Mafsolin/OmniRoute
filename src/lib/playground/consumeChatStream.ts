import { SseDecoder } from "./sseDecoder";

export type Usage = Record<string, unknown>;
export interface ToolCall {
  index: number;
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface DeliveryCallbacks {
  onTools?(tools: ToolCall[]): void;
  onEvent?(): void;
  onFrame?(event: string, payload: Record<string, unknown>): void;
  onText?(text: string): void;
  onReasoning?(text: string): void;
}
export interface ChatStreamResult {
  usage?: Usage;
  toolCalls: ToolCall[];
  finishReason: string | null;
  hasTools: boolean;
  hasText: boolean;
  hasReasoning: boolean;
}
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Consume complete SSE frames; failures never discard text already delivered to callbacks. */
export async function consumeChatStream(
  body: ReadableStream<Uint8Array>, callbacks: DeliveryCallbacks = {}, signal?: AbortSignal,
): Promise<ChatStreamResult> {
  const reader = body.getReader();
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    const reason = signal?.reason ?? new DOMException("Aborted", "AbortError");
    rejectAbort(reason);
    void reader.cancel(reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new SseDecoder();
  const result: ChatStreamResult = { finishReason: null, hasTools: false, hasText: false, hasReasoning: false, toolCalls: [] };
  let terminal = false;
  let transportDone = false;
  const consume = (data: string, event: string) => {
    if (transportDone) return;
    if (data.trim() === "[DONE]") { terminal = true; transportDone = true; return; }
    const parsed = record(JSON.parse(data));
    callbacks.onEvent?.();
    callbacks.onFrame?.(event, parsed);
    if (parsed.error) {
      throw new Error(String(record(parsed.error).message || "upstream stream failed"));
    }
    if (parsed.usage) result.usage = record(parsed.usage);
    const type = typeof parsed.type === "string" ? parsed.type : event;
    if (type === "response.output_text.delta" && typeof parsed.delta === "string" && parsed.delta.length) {
      result.hasText = true;
      callbacks.onText?.(parsed.delta);
    }
    if (type === "response.completed") {
      const response = record(parsed.response);
      if (response.usage) result.usage = record(response.usage);
      result.finishReason = "stop";
      terminal = true;
      transportDone = true;
    }
    if (type === "response.incomplete") {
      const response = record(parsed.response);
      if (response.usage) result.usage = record(response.usage);
      const reason = record(response.incomplete_details).reason;
      result.finishReason = reason === "max_output_tokens" ? "length" : typeof reason === "string" && reason ? reason : "incomplete";
      terminal = true;
      transportDone = true;
    }
    if (type === "response.failed") {
      const failure = record(record(parsed.response).error);
      throw new Error(String(failure.message || "upstream response failed"));
    }
    if (Array.isArray(parsed.choices)) {
      const choice = record(parsed.choices[0]);
      const delta = record(choice.delta);
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : delta.function_call ? [{ index: 0, function: delta.function_call }] : [];
      for (const value of calls) {
        const call = record(value);
        const index = typeof call.index === "number" ? call.index : 0;
        let tool = result.toolCalls.find(t => t.index === index);
        if (!tool) { tool = { index, type: "function", function: { name: "", arguments: "" } }; result.toolCalls.push(tool); }
        if (typeof call.id === "string") tool.id = call.id;
        const fn = record(call.function);
        if (typeof fn.name === "string") tool.function.name += fn.name;
        if (typeof fn.arguments === "string") tool.function.arguments += fn.arguments;
        result.hasTools = true;
      }
      if (calls.length) {
        result.toolCalls.sort((a, b) => a.index - b.index);
        callbacks.onTools?.(result.toolCalls.map(t => ({ ...t, function: { ...t.function } })));
      }
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        result.hasReasoning = true;
        callbacks.onReasoning?.(reasoning);
      }
      if (typeof choice.finish_reason === "string") { result.finishReason = choice.finish_reason; terminal = true; }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        result.hasText = true;
        callbacks.onText?.(delta.content);
      }
    }
  };
  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (done) break;
      for (const frame of decoder.push(value)) consume(frame.data, frame.event);
      if (transportDone) { await reader.cancel().catch(() => {}); break; }
    }
    if (!transportDone) for (const frame of decoder.finish()) consume(frame.data, frame.event);
    if (!terminal) throw new Error("stream_truncated: terminal event missing");
    return result;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
