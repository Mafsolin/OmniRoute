import type { ConfigState } from "@/app/(dashboard)/dashboard/playground/components/StudioConfigPane";
import { buildReasoningRequestFields, type ReasoningControlSpec } from "@/app/(dashboard)/dashboard/playground/components/reasoningControlUtils";

export interface ChatInput { role: string; content: string }

/** Shared Chat/Compare serialization: never silently increase the user's output budget. */
export function buildPlaygroundChatRequest(
  config: ConfigState, messages: ChatInput[], model = config.model,
  spec: ReasoningControlSpec = config.reasoning ?? { show: false, effortOptions: [] },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model, stream: true, stream_options: { include_usage: true },
    messages: [
      ...(config.systemPrompt.trim() ? [{ role: "system", content: config.systemPrompt }] : []),
      ...messages.filter(item => item.role !== "system").map(({ role, content }) => ({ role, content })),
    ],
  };
  const p = config.params;
  if (p.temperature !== 1) body.temperature = p.temperature;
  if (p.max_tokens > 0) body.max_tokens = p.max_tokens;
  if (p.top_p !== 1) body.top_p = p.top_p;
  if (p.presence_penalty !== 0) body.presence_penalty = p.presence_penalty;
  if (p.frequency_penalty !== 0) body.frequency_penalty = p.frequency_penalty;
  if (p.seed !== null) body.seed = p.seed;
  if (p.stop.trim()) body.stop = p.stop;
  if (p.jsonMode) body.response_format = { type: "json_object" };
  Object.assign(body, buildReasoningRequestFields({ effort: p.effort, thinking: p.thinking }, spec));
  return body;
}
