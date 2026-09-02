export type CodexQuotaScope = "codex" | "spark";

export const CODEX_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
export const CODEX_SPARK_DISPLAY_NAME = "GPT-5.3-Codex-Spark";
export const CODEX_SPARK_METERED_FEATURE = "gpt_5_3_codex_spark";
export const CODEX_SPARK_QUOTA_SESSION = `${CODEX_SPARK_METERED_FEATURE}_session`;
export const CODEX_SPARK_QUOTA_WEEKLY = `${CODEX_SPARK_METERED_FEATURE}_weekly`;
export const CODEX_LUNA_MODEL_ID = "gpt-5.6-luna";
export const CODEX_LUNA_RESERVE_QUOTA = "gpt-reserve";
export const CODEX_LUNA_RESERVE_QUOTA_WEEKLY = "gpt-reserve_weekly";

const CODEX_SCOPE_PATTERNS: Array<{ pattern: string; scope: CodexQuotaScope }> = [
  { pattern: "codex-spark", scope: "spark" },
  { pattern: "spark", scope: "spark" },
  { pattern: "bengalfox", scope: "spark" },
  { pattern: "codex", scope: "codex" },
  { pattern: "gpt-5", scope: "codex" },
];

export function getCodexModelScope(model: string | null | undefined): CodexQuotaScope {
  const lower = String(model || "").toLowerCase();
  for (const { pattern, scope } of CODEX_SCOPE_PATTERNS) {
    if (lower.includes(pattern)) return scope;
  }
  return "codex";
}

/**
 * Luna is part of the normal Codex scope, but ChatGPT can expose an additional
 * `gpt-reserve` window that only Luna may spend after the regular short window
 * is exhausted. Keep this predicate separate from `getCodexModelScope()` so
 * Sol/Terra never inherit Luna's reserve capacity.
 */
export function isCodexLunaModel(model: string | null | undefined): boolean {
  return String(model || "")
    .toLowerCase()
    .includes(CODEX_LUNA_MODEL_ID);
}

export function getCodexRateLimitKey(accountId: string, model: string): string {
  return `${accountId}:${getCodexModelScope(model)}`;
}

export function isCodexSparkQuotaKey(key: string | null | undefined): boolean {
  const normalized = String(key || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return (
    normalized === CODEX_SPARK_QUOTA_SESSION ||
    normalized === CODEX_SPARK_QUOTA_WEEKLY ||
    normalized === "codex-spark" ||
    normalized === "codex-spark-weekly" ||
    normalized.includes("codex-spark") ||
    normalized.includes("codex_spark") ||
    normalized.includes(CODEX_SPARK_METERED_FEATURE)
  );
}

export function isCodexLunaReserveQuotaKey(key: string | null | undefined): boolean {
  const normalized = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (
    normalized === "gpt_reserve" ||
    normalized === "luna_reserve" ||
    normalized === "gpt_reserve_weekly" ||
    normalized === "luna_reserve_weekly"
  );
}

export function isCodexLunaReserveLimitDescriptor(...values: unknown[]): boolean {
  return values.some((value) => {
    if (typeof value !== "string") return false;
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, "-");
    return (
      normalized === "gpt-reserve" ||
      normalized === "luna-reserve" ||
      normalized === "gpt-reserve-weekly" ||
      normalized === "luna-reserve-weekly"
    );
  });
}

export function isCodexSparkLimitDescriptor(...values: unknown[]): boolean {
  return values.some((value) => {
    if (typeof value !== "string") return false;
    const normalized = value.trim().toLowerCase();
    return (
      normalized.includes("spark") ||
      normalized.includes("bengalfox") ||
      normalized.includes(CODEX_SPARK_METERED_FEATURE)
    );
  });
}

export function getCodexQuotaWindowFilterForModel(
  model: string | null | undefined
): ((windowName: string) => boolean) | undefined {
  if (!model) return undefined;
  const scope = getCodexModelScope(model);
  return (windowName: string) => {
    const isSpark = isCodexSparkQuotaKey(windowName);
    if (scope === "spark") return isSpark;
    // The reserve is an entitlement of Luna only. Standard Codex models must
    // not look healthy merely because a Luna reserve row is cached beside them.
    if (isCodexLunaReserveQuotaKey(windowName)) return isCodexLunaModel(model);
    return !isSpark;
  };
}

export function toCodexScopedQuotaWindowName(
  baseWindowName: string,
  model: string | null | undefined
): string {
  if (!model || getCodexModelScope(model) !== "spark") return baseWindowName;
  const normalized = baseWindowName.trim().toLowerCase();
  if (normalized === "session") return CODEX_SPARK_QUOTA_SESSION;
  if (normalized === "weekly") return CODEX_SPARK_QUOTA_WEEKLY;
  return baseWindowName;
}

export function toCodexBaseQuotaWindowName(windowName: string | null): string | null {
  if (!windowName) return windowName;
  const normalized = windowName.trim().toLowerCase();
  if (normalized === CODEX_SPARK_QUOTA_SESSION || normalized === "codex-spark") return "session";
  if (normalized === CODEX_SPARK_QUOTA_WEEKLY || normalized === "codex-spark-weekly") {
    return "weekly";
  }
  return windowName;
}
