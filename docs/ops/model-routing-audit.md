---
title: "Model routing safety audit (D2)"
---

# Model routing safety audit — quota, retry, abort, account fallback

Read-only audit (D2 of the quality/speed plan), 2026-10-08. No production
settings changed. Sources: the routing seams cited below plus the contract suite
`tests/unit/{persist-429-cooldown-account-fallback, self-inflicted-upstream-timeout,
provider-health-inconclusive-probes, account-fallback-cf1010-no-retry-8775,
stream-throughput-watchdog-recovery, chatcore-upstream-timeouts}.test.ts` —
29/29 pass on the current tree (isolated DATA_DIR/TMPDIR, concurrency=1).

## Verified semantics

1. **Eligible accounts, canonical model, effort aliases.**
   - Selection uses `isActive` plus cooldown windows (`rateLimitedUntil`) and
     returns connections to the pool after the cooldown
     (`open-sse/services/accountFallback.ts:130`, `:2250-2298`, `:2316-2328`).
   - Effort-variant model ids are normalized back to the canonical upstream id
     while surfacing the level as reasoning effort; an explicit client-supplied
     effort always wins (`open-sse/handlers/chatCore/claudeEffortVariant.ts:7-29`).
2. **429 / quota resets.**
   - Reset headers are parsed per provider family — `x-ratelimit-reset-*`,
     `anthropic-ratelimit-*-reset`, `retry-after`
     (`open-sse/services/rateLimitManager/headers.ts:9-31`) plus structured
     hints (`google_rpc_retry_info`, body) in `open-sse/services/retryAfterJson.ts`.
   - The cooldown is applied to `rateLimitedUntil`; selection skips the
     connection until the reset instead of hammering the forbidden endpoint
     (`accountFallback.ts:2250-2274`).
3. **Client abort never degrades provider score.**
   - Abort cancellations are treated as intentional ("recovering them would
     replay a..."): no recovery attempt, no failure attribution
     (`open-sse/services/streamRecovery.ts:139`).
4. **400 / context overflow is not retried blindly.**
   - `context overflow` is classified (`open-sse/services/errorClassifier.ts:94`);
     the 400 branches distinguish model-unavailable, regional refusals
     (`:310-320`), credits/quota (`:259`) and generic (`:416`) — affected
     accounts are excluded instead of blindly re-selected.
5. **Three different timeouts.**
   - Headers: `createUpstreamStartTimeoutError`
     (`open-sse/handlers/chatCore/upstreamTimeouts.ts:37+`); idle between
     generated chunks: `createBodyTimeoutError` (`:13-22`, applied per read via
     `readStreamChunkWithTimeout`); separate overall fetch deadline policies
     under `open-sse/utils/fetchStartTimeoutPolicy.ts` and
     `open-sse/utils/directResponseStartTimeout.ts`.
6. **Thinking phases are protected from the throughput watchdog.**
   - Heartbeats/metadata and tool/reasoning phases do not count as assistant
     output and suspend judgement (`open-sse/services/throughputWatchdog.ts:5-6,
     :58, :76-77, :89, :97`); abort fires only when a complete window is ready,
     the phase is not protected and throughput is measurably low (`:130-163`).
7. **Pre-output retry vs post-output no-replay.**
   - A retryable cut before client-visible output resumes; after output the
     failure propagates unchanged — "we never replay a request the caller has
     already seen" (`streamRecovery.ts:178`, `:371`); reasoning-only tracking
     keeps a provider that spent the whole turn thinking from being treated as
     a stall (`:429-471`).
8. **autoDisableBannedScope cannot disable a pool off one inconclusive fail.**
   - Auto-disable requires `permanent: true`
     (`src/sse/services/autoDisableBannedAccount.ts:25`); probe-origin failures
     never disable a connection (#9817, `:27-33`); the scope gate
     (`shouldAutoDisableBannedConnection`, scope `all` vs subscription-only,
     default `"all"` in `src/lib/db/settings.ts:233`) selects which auth classes
     are eligible — a single transient or regional refusal never deactivates an
     account.

## Contract run

    tests 29 / pass 29 / fail 0   (six files above, isolated DATA_DIR, concurrency=1)

## Named defects

None found. No retry-engine rewrite and no timeout-configuration change is
required by this audit.
