export class FetchJsonDeadlineError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`JSON request deadline exceeded after ${timeoutMs}ms`);
    this.name = "FetchJsonDeadlineError";
  }
}

/** Bound the entire request, including JSON consumption, even for non-cooperative fetches. */
export async function fetchJsonWithDeadline<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number; fetchFn?: typeof fetch } = {}
): Promise<T> {
  const { timeoutMs = 5000, fetchFn = fetch, signal, ...init } = options;
  const controller = new AbortController();
  let rejectAbort: (reason: unknown) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    const error = signal?.reason ?? new DOMException("Aborted", "AbortError");
    controller.abort(error);
    rejectAbort(error);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new FetchJsonDeadlineError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const request = (async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} loading provider data`);
    return await response.json() as T;
  })();
  try {
    return await Promise.race([request, deadline, cancelled]);
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener("abort", abort);
  }
}
