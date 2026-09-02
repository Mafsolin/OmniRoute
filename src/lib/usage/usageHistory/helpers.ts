/**
 * Pure, stateless helpers extracted from usageHistory.ts.
 * No DB access, no module-level state — safe to import anywhere.
 */

// #7879: re-export the canonical helper so existing consumers of this module
// keep importing `toNumber` from here unchanged.
export { toNumber } from "@/shared/utils/numeric";

type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function normalizeServiceTier(value: unknown): string {
  const tier = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (tier === "priority" || tier === "fast") return "priority";
  if (tier === "flex") return "flex";
  return "standard";
}

export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const bounded = Math.max(0, Math.min(1, p));
  const idx = Math.round((sortedValues.length - 1) * bounded);
  return sortedValues[idx] ?? sortedValues[sortedValues.length - 1];
}

export function stdDev(values: number[], avg: number): number {
  if (values.length <= 1) return 0;
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

export function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((acc, n) => acc + n, 0) / values.length : 0;
}

/** Resolve a positive-numeric option, falling back when unset/non-finite/<=0. */
export function resolvePositiveOption(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Per-key accumulator buckets used by getModelLatencyStats() (#6875). */
export interface LatencySampleBuckets {
  successfulLatencies: number[];
  allLatencies: number[];
  successfulTtfts: number[];
  allTtfts: number[];
  successfulTps: number[];
  allTps: number[];
  /** Numerator/denominator pairs for a weighted post-TTFT TPS aggregate. */
  successfulTpsOutputTokens: number;
  successfulTpsGenerationMs: number;
  allTpsOutputTokens: number;
  allTpsGenerationMs: number;
}

/**
 * Push one usage_history row's latency/TTFT/tokens-per-second sample into the
 * accumulator buckets. TPS measures only the decode phase (end-to-end latency
 * minus TTFT) and is accumulated as total output tokens / total decode time.
 * This weighted form avoids a short one-token response dominating a long
 * generation when the dashboard aggregates many requests. Rows with no valid
 * decode interval or no provider-reported output tokens are excluded from TPS,
 * while still contributing to latency/TTFT statistics.
 */
export function accumulateLatencySample(
  buckets: LatencySampleBuckets,
  latencyMs: number,
  ttftMs: number,
  tokensOutput: number,
  isSuccess: boolean
): void {
  if (latencyMs <= 0) return;
  buckets.allLatencies.push(latencyMs);
  if (ttftMs > 0) buckets.allTtfts.push(ttftMs);
  const generationMs = latencyMs - ttftMs;
  if (generationMs > 0 && tokensOutput > 0) {
    buckets.allTps.push(tokensOutput / (generationMs / 1000));
    buckets.allTpsOutputTokens += tokensOutput;
    buckets.allTpsGenerationMs += generationMs;
  }
  if (!isSuccess) return;
  buckets.successfulLatencies.push(latencyMs);
  if (ttftMs > 0) buckets.successfulTtfts.push(ttftMs);
  if (generationMs > 0 && tokensOutput > 0) {
    buckets.successfulTps.push(tokensOutput / (generationMs / 1000));
    buckets.successfulTpsOutputTokens += tokensOutput;
    buckets.successfulTpsGenerationMs += generationMs;
  }
}

/** Per-provider/model accumulator for getModelLatencyStats() (#6875). */
export interface LatencyBucket extends LatencySampleBuckets {
  provider: string;
  model: string;
  totalRequests: number;
  successfulRequests: number;
}

export function createLatencyBucket(provider: string, model: string): LatencyBucket {
  return {
    provider,
    model,
    totalRequests: 0,
    successfulRequests: 0,
    successfulLatencies: [],
    allLatencies: [],
    successfulTtfts: [],
    allTtfts: [],
    successfulTps: [],
    allTps: [],
    successfulTpsOutputTokens: 0,
    successfulTpsGenerationMs: 0,
    allTpsOutputTokens: 0,
    allTpsGenerationMs: 0,
  };
}

/** Aggregate view returned per provider/model key by getModelLatencyStats(). */
export interface ModelLatencyStatsEntry {
  provider: string;
  model: string;
  key: string;
  totalRequests: number;
  successfulRequests: number;
  successRate: number; // 0..1
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  latencyStdDev: number;
  windowHours: number;
  /** Mean time-to-first-token (ms) across the same sample set as avgLatencyMs. */
  avgTtftMs: number;
  /**
   * End-to-end latency (ms). Aliases avgLatencyMs: usage_history has no
   * distinct second latency column beyond latency_ms/ttft_ms, so latency_ms
   * already represents the full request wall-clock time (#6875).
   */
  avgE2ELatencyMs: number;
  /** Weighted output tokens/sec after TTFT, using provider-reported output tokens. */
  avgTokensPerSecond: number | null;
  /** Raw TPS numerator used to aggregate provider-level throughput correctly. */
  tpsOutputTokens: number;
  /** Raw TPS denominator in milliseconds used to aggregate provider-level throughput. */
  tpsGenerationMs: number;
  /** Number of rows contributing to the TPS numerator/denominator. */
  tpsSampleCount: number;
}

/**
 * Reduce one accumulator bucket into its final ModelLatencyStatsEntry, or
 * null when the effective sample count is below minSamples. Falls back from
 * successful-only to all-sample data for latency/TTFT/tokens-per-second
 * consistently (mirrors the pre-existing avgLatencyMs fallback behavior).
 */
export function buildLatencyStatsEntry(
  key: string,
  bucket: LatencyBucket,
  minSamples: number,
  windowHours: number
): ModelLatencyStatsEntry | null {
  const useSuccessful = bucket.successfulLatencies.length >= minSamples;
  const baseLatencies = useSuccessful ? bucket.successfulLatencies : bucket.allLatencies;
  if (baseLatencies.length < minSamples) return null;

  const baseTtfts = useSuccessful ? bucket.successfulTtfts : bucket.allTtfts;
  const baseTps = useSuccessful ? bucket.successfulTps : bucket.allTps;
  const tpsOutputTokens = useSuccessful
    ? bucket.successfulTpsOutputTokens
    : bucket.allTpsOutputTokens;
  const tpsGenerationMs = useSuccessful
    ? bucket.successfulTpsGenerationMs
    : bucket.allTpsGenerationMs;

  const sorted = [...baseLatencies].sort((a, b) => a - b);
  const avg = mean(sorted);
  const successRate =
    bucket.totalRequests > 0 ? bucket.successfulRequests / bucket.totalRequests : 0;

  return {
    provider: bucket.provider,
    model: bucket.model,
    key,
    totalRequests: bucket.totalRequests,
    successfulRequests: bucket.successfulRequests,
    successRate,
    avgLatencyMs: Math.round(avg),
    p50LatencyMs: Math.round(percentile(sorted, 0.5)),
    p95LatencyMs: Math.round(percentile(sorted, 0.95)),
    p99LatencyMs: Math.round(percentile(sorted, 0.99)),
    latencyStdDev: Math.round(stdDev(sorted, avg)),
    windowHours,
    avgTtftMs: Math.round(mean(baseTtfts)),
    avgE2ELatencyMs: Math.round(avg),
    avgTokensPerSecond:
      tpsGenerationMs > 0 && tpsOutputTokens > 0
        ? Math.round((tpsOutputTokens / (tpsGenerationMs / 1000)) * 100) / 100
        : null,
    tpsOutputTokens,
    tpsGenerationMs,
    tpsSampleCount: baseTps.length,
  };
}

export const MAX_PREVIEW_DEPTH = 6;
export const MAX_PREVIEW_STRING = 1200;
export const MAX_PREVIEW_ARRAY_ITEMS = 12;
export const MAX_PREVIEW_OBJECT_KEYS = 24;

export function truncatePendingPreview(value: unknown, depth = 0): unknown {
  if (depth >= MAX_PREVIEW_DEPTH) {
    return "[TRUNCATED_DEPTH]";
  }

  if (typeof value === "string") {
    return value.length > MAX_PREVIEW_STRING ? `${value.slice(0, MAX_PREVIEW_STRING)}...` : value;
  }

  if (Array.isArray(value)) {
    const preview = value
      .slice(0, MAX_PREVIEW_ARRAY_ITEMS)
      .map((item) => truncatePendingPreview(item, depth + 1));
    if (value.length > MAX_PREVIEW_ARRAY_ITEMS) {
      preview.push({ _truncatedItems: value.length - MAX_PREVIEW_ARRAY_ITEMS });
    }
    return preview;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value as JsonRecord);
  const truncatedEntries = entries
    .slice(0, MAX_PREVIEW_OBJECT_KEYS)
    .map(([key, entryValue]) => [key, truncatePendingPreview(entryValue, depth + 1)]);
  const preview = Object.fromEntries(truncatedEntries);

  if (entries.length > MAX_PREVIEW_OBJECT_KEYS) {
    preview._truncatedKeys = entries.length - MAX_PREVIEW_OBJECT_KEYS;
  }

  return preview;
}
