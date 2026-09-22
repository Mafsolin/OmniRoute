/**
 * Canonical streaming timing instrumentation (TTFT / ITL / interruption).
 *
 * One reusable seam for measuring the streaming path. It is created once per
 * stream and marked from the SSE transform:
 *
 *   markByte()     — first upstream chunk received (bytes arrived from provider)
 *   markForward()  — first chunk forwarded to the client (first SSE chunk enqueued)
 *
 * `ttft()` is therefore **first-forwarded-SSE-chunk latency**, NOT token-level
 * TTFT. We document that distinction explicitly: a single SSE chunk can carry
 * zero, one, or many tokens, and chunk boundaries do not map to token
 * boundaries. If a future implementation can measure actual token timing it
 * should extend this seam, not bypass it.
 *
 * ITL (inter-token latency) is approximated by the mean gap between forwarded
 * SSE chunks (bounded sample window). It is a chunk-latency proxy, again not
 * true token timing — callers must label it as such.
 *
 * The object is cheap to construct, plain mutable state, and safe under the
 * event loop's single thread (each stream owns its own instance).
 *
 * All timestamps are sampled from `performance.now()` (a monotonic clock,
 * milliseconds since an arbitrary process-relative origin), NOT `Date.now()`
 * (wall clock). Every field here is consumed only as an intra-instance delta
 * (`ttftMs`, `avgItlMs`, `totalMs`), so a monotonic source keeps TTFT/ITL
 * immune to NTP steps and wall-clock jumps that would otherwise poison the
 * router's quality signals. Consequently these values are NOT epoch timestamps
 * and must never be serialized, persisted, or compared across StreamTiming
 * instances as absolute times — the same convention `earlyStreamKeepalive.ts`
 * already follows on this streaming path.
 */
export interface StreamTiming {
  startedAt: number;
  firstByteAt: number | null;
  firstForwardAt: number | null;
  /**
   * First forwarded chunk that carried real generated output (token text,
   * reasoning, or tool-call arguments) — as opposed to protocol scaffolding
   * like `response.created`, SSE comments or keepalive frames. This is what
   * TTFT is measured from; see `markGeneratedOutput`.
   */
  firstGeneratedOutputAt: number | null;
  lastForwardAt: number | null;
  /** Mean gap between forwarded chunks (ms), bounded window. */
  interChunkGaps: number[];
  forwardedChunks: number;
  interrupted: boolean;
  markByte(): void;
  markForward(): void;
  /**
   * Mark the first chunk carrying real generated output. Callers pass the
   * result of a format-aware content predicate; scaffolding events must not
   * call this. Idempotent — only the first call is recorded.
   */
  markGeneratedOutput(): void;
  markInterrupted(): void;
  /**
   * Time to first generated output token in ms, or null when the stream
   * forwarded nothing of value. Falls back to first-forwarded-chunk latency
   * only when no chunk was ever classified as generated output, so a provider
   * whose events this build cannot classify degrades to the old signal rather
   * than reporting null.
   */
  ttftMs(): number | null;
  /** Mean inter-chunk gap in ms, or null when fewer than 2 chunks were forwarded. */
  avgItlMs(): number | null;
  /** Time from stream start to completion (ms). */
  totalMs(): number;
}

/** Max number of inter-chunk samples kept (bounds memory). */
const MAX_INTER_CHUNK_GAPS = 32;

export function createStreamTiming(): StreamTiming {
  const timing: StreamTiming = {
    startedAt: performance.now(),
    firstByteAt: null,
    firstForwardAt: null,
    firstGeneratedOutputAt: null,
    lastForwardAt: null,
    interChunkGaps: [],
    forwardedChunks: 0,
    interrupted: false,
    markByte() {
      if (this.firstByteAt === null) this.firstByteAt = performance.now();
    },
    markForward() {
      const now = performance.now();
      if (this.firstForwardAt === null) this.firstForwardAt = now;
      if (this.lastForwardAt !== null && this.interChunkGaps.length < MAX_INTER_CHUNK_GAPS) {
        this.interChunkGaps.push(now - this.lastForwardAt);
      }
      this.lastForwardAt = now;
      this.forwardedChunks += 1;
    },
    markGeneratedOutput() {
      if (this.firstGeneratedOutputAt === null) this.firstGeneratedOutputAt = performance.now();
    },
    markInterrupted() {
      this.interrupted = true;
    },
    ttftMs() {
      // Prefer the first real generated token. Scaffolding (`response.created`,
      // SSE comments, keepalives) is forwarded within a few ms of the request,
      // so measuring from firstForwardAt reported ~10 ms TTFT against a 12 s
      // latency and made the decode-rate/TPS derivation meaningless.
      const at = this.firstGeneratedOutputAt ?? this.firstForwardAt;
      return at === null ? null : at - this.startedAt;
    },
    avgItlMs() {
      if (this.interChunkGaps.length === 0) return null;
      const sum = this.interChunkGaps.reduce((a, b) => a + b, 0);
      return sum / this.interChunkGaps.length;
    },
    totalMs() {
      return performance.now() - this.startedAt;
    },
  };
  return timing;
}
