/**
 * Login brute-force guard.
 *
 * Tracks failed `/api/auth/login` attempts per client IP in process memory
 * and returns lockout decisions. Single-process scope is intentional — this
 * is a defense-in-depth check that pairs with Cloudflare/reverse-proxy rate
 * limiting, not a substitute for it.
 *
 * Tunables:
 *   - three failures within `WINDOW_MS` advance the escalation stage
 *   - stage 1 locks for 15 minutes, stage 2 locks for 24 hours, stage 3
 *     permanently adds the IP to the OmniRoute IP blacklist
 *   - sliding window: `WINDOW_MS`
 *
 * The guard is a no-op when `enabled` is false; the caller decides based on
 * the `bruteForceProtection` setting (default true).
 */

const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const LONG_LOCKOUT_MS = 24 * 60 * 60 * 1000;
const FAILURE_THRESHOLD = 3;
const MAX_ESCALATION_STAGE = 2;

interface AttemptState {
  count: number;
  firstAttemptAt: number;
  lockedUntil: number | null;
  /** 0 = first 15-minute lock, 1 = next 24-hour lock, 2 = next permanent ban. */
  escalationStage: number;
}

const attempts: Map<string, AttemptState> = new Map();

// Above this many tracked IPs, opportunistically drop entries whose window has elapsed and
// that are not currently locked. Without this the map only ever grew (entries were deleted
// only on a *successful* login), so every distinct IP that ever failed a login leaked a
// permanent entry — unbounded under distributed brute-force. Expired/unlocked entries are
// already treated as "allowed", so removing them never changes a guard decision.
const PRUNE_THRESHOLD = 256;

function pruneExpiredAttempts(now: number): void {
  for (const [key, state] of attempts) {
    const windowElapsed = now - state.firstAttemptAt > WINDOW_MS;
    const notLocked = !state.lockedUntil || state.lockedUntil <= now;
    if (windowElapsed && notLocked) attempts.delete(key);
  }
}

export interface GuardDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
  /** True when this failure crossed the final escalation threshold. */
  permanentBan?: boolean;
  /** Current escalation stage, useful for audit logging and tests. */
  escalationStage?: number;
}

function nowMs(): number {
  return Date.now();
}

function clientKey(rawIp: string | null | undefined): string {
  const ip = (rawIp || "").trim();
  return ip || "__unknown__";
}

export function checkLoginGuard(
  rawIp: string | null | undefined,
  options: { enabled: boolean }
): GuardDecision {
  if (!options.enabled) return { allowed: true };
  const state = attempts.get(clientKey(rawIp));
  if (!state) return { allowed: true };
  const now = nowMs();
  if (state.lockedUntil && state.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
      escalationStage: state.escalationStage,
    };
  }
  return { allowed: true };
}

export function recordLoginFailure(
  rawIp: string | null | undefined,
  options: { enabled: boolean }
): GuardDecision {
  if (!options.enabled) return { allowed: true };
  const key = clientKey(rawIp);
  const now = nowMs();

  // Keep the map from growing without bound as distinct IPs fail logins over time.
  if (attempts.size > PRUNE_THRESHOLD) pruneExpiredAttempts(now);

  const existing = attempts.get(key);

  if (!existing || now - existing.firstAttemptAt > WINDOW_MS) {
    attempts.set(key, {
      count: 1,
      firstAttemptAt: now,
      lockedUntil: null,
      // A completed lockout is a new escalation cycle. The next three
      // failures after the 15-minute lock start the 24-hour stage, and the
      // next cycle reaches the permanent ban.
      escalationStage:
        existing?.lockedUntil && existing.lockedUntil <= now ? existing.escalationStage || 0 : 0,
    });
    const escalationStage =
      existing?.lockedUntil && existing.lockedUntil <= now ? existing.escalationStage || 0 : 0;
    return { allowed: true, escalationStage };
  }

  const nextCount = existing.count + 1;
  if (nextCount >= FAILURE_THRESHOLD) {
    const escalationStage = existing.escalationStage;
    if (escalationStage >= MAX_ESCALATION_STAGE) {
      attempts.set(key, {
        count: nextCount,
        firstAttemptAt: existing.firstAttemptAt,
        lockedUntil: null,
        escalationStage: MAX_ESCALATION_STAGE + 1,
      });
      return {
        allowed: false,
        permanentBan: true,
        escalationStage: MAX_ESCALATION_STAGE + 1,
      };
    }
    const lockedUntil = now + (escalationStage === 0 ? LOCKOUT_MS : LONG_LOCKOUT_MS);
    attempts.set(key, {
      count: nextCount,
      firstAttemptAt: existing.firstAttemptAt,
      lockedUntil,
      escalationStage: escalationStage + 1,
    });
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000),
      escalationStage: escalationStage + 1,
    };
  }

  attempts.set(key, {
    count: nextCount,
    firstAttemptAt: existing.firstAttemptAt,
    lockedUntil: null,
    escalationStage: existing.escalationStage,
  });
  return { allowed: true, escalationStage: existing.escalationStage };
}

export function clearLoginAttempts(rawIp: string | null | undefined): void {
  attempts.delete(clientKey(rawIp));
}

export function resetLoginGuardForTests(): void {
  attempts.clear();
}

/** Test-only: current number of tracked IP entries. */
export function getLoginGuardSizeForTests(): number {
  return attempts.size;
}

export const LOGIN_GUARD_TUNABLES = Object.freeze({
  WINDOW_MS,
  LOCKOUT_MS,
  LONG_LOCKOUT_MS,
  FAILURE_THRESHOLD,
  MAX_ESCALATION_STAGE,
});
