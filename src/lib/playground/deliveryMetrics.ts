import type { StreamMetrics } from "@/shared/schemas/playground";
import type { Usage } from "./consumeChatStream";
import { getReasoningTokensOrNull } from "../usage/tokenAccounting";
import { computeMetrics, type ComputeMetricsArgs } from "./streamMetrics";

const count = (v: unknown): number | null => typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

/** One monotonic clock per logical request, starting before fetch. */
export class DeliveryTracker {
  private start: number;
  private firstEvent: number | null = null;
  private firstText: number | null = null;
  private lastText: number | null = null;
  private textEvents = 0;
  private reasoningObserved = false;
  private nonTextOutput = false;
  constructor(private readonly now: () => number = () => performance.now()) { this.start = now(); }
  event() { this.firstEvent ??= this.now(); }
  reasoning() { this.event(); this.reasoningObserved = true; }
  tool() { this.event(); this.nonTextOutput = true; }
  text() {
    const at = this.now();
    this.firstEvent ??= at;
    this.firstText ??= at;
    this.lastText = at;
    this.textEvents += 1;
  }
  finish(usage: Usage = {}, pricing?: ComputeMetricsArgs["pricing"]): StreamMetrics {
    const totalMs = Math.max(0, this.now() - this.start);
    const input = count(usage.prompt_tokens ?? usage.input_tokens);
    const tokensIn = input ?? 0;
    const reported = count(usage.completion_tokens ?? usage.output_tokens);
    const base = computeMetrics({ startedAt: 0, firstChunkAt: this.firstText === null ? null : this.firstText - this.start, finishedAt: totalMs, tokensIn, tokensOut: reported ?? 0, pricing });
    const reasoningTokens = count(getReasoningTokensOrNull(usage));
    const visibleTokens = reported !== null && reasoningTokens !== null && !(this.reasoningObserved && reasoningTokens === 0) && !this.nonTextOutput && reported >= reasoningTokens ? reported - reasoningTokens : null;
    const span = this.firstText !== null && this.lastText !== null ? this.lastText - this.firstText : 0;
    const known = visibleTokens !== null && visibleTokens > 0 && span > 0;
    const sustained = known && span >= 3000 && this.textEvents >= 8;
    return {
      ...base,
      costUsd: input !== null && reported !== null ? base.costUsd : null,
      visibleTokens,
      reasoningTokens,
      visibleTps: sustained ? visibleTokens! / (span / 1000) : null,
      outputTps: reported !== null && totalMs > 0 ? reported / (totalMs / 1000) : null,
      tpsKind: sustained ? "delivery" : known ? "burst" : "unknown",
      reportedTokensIn: input,
      reportedTokensOut: reported,
      firstEventMs: this.firstEvent === null ? null : this.firstEvent - this.start,
      firstTextMs: this.firstText === null ? null : this.firstText - this.start,
    };
  }
}
