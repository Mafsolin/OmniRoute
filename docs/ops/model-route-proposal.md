---
title: "Model route proposal (D4) — reserves for the probed models"
---

# Model route proposal — verified reserves, nothing applied

Scope: the four models exercised in D3 (`docs/ops/model-quality-results.md`) plus their
real production config targets read from the management API on 2026-10-08
(`/api/combos`, `/api/providers`, `/v1/models`, `/api/usage/model-latency-stats`).

**Status: proposal only — no config change has been applied.** Applying anything below
requires explicit approval; the apply path is the management API with an exact-JSON
backup and a readback of the target id (never a direct SQLite UPDATE). `free-stack` is
not touched by any item here.

## Evidence used

| Source | What it gives |
|---|---|
| D3 probe runs (19 runs, 16 PASS) | objective output contract per model, actual route model, selected connection id |
| `/api/usage/model-latency-stats` (24h) | observed failure rate and latency percentiles with real sample sizes |
| `/api/providers` | connection inventory: 3 active antigravity accounts (priorities 1/2/3), 1 opencode-go, 1 opencode; all `testStatus=active`, `backoffLevel=0` |
| `/v1/models` (`root` field) | canonical-model identity for cross-provider reserves |
| Exact current config backup | `/opt/omniroute-quality-speed-data/d4/{combos,providers,models,latency}.json` (server-side; contains account emails — not committed) |

Reserve candidates are matched by identical catalog `root` (same canonical model) on a
different provider/connection, and every candidate connection is active with a recent
health check. Cross-provider reserves were **not** live-probed (D3 live budget closed) —
each is marked as requiring a small confirmation wave before being used as a default.

## Per-model decision

### opencode-go/deepseek-flash — keep as explicit route; no real reserve (risk noted)

- Main route: `opencode-go/deepseek-flash` → connection `main` (14e87fcb-…), the only
  opencode-go account; probes selected it every time (6/6 runs with header captured).
- Observed 24h: 257 req, 249 ok (96.9%), p50 11.2s, p95 65.9s, TTFT 950 ms, TPS 70.3
  (214 TPS samples).
- Reserve to the same canonical model: **none exists.** `deepseek-flash` root appears
  only under opencode-go. Sibling ids (`deepseek-v4-flash`, `deepseek-v4.1-flash`) are
  different canonical models on the same single account, so they are not reserves —
  they are downgrades/upgrades of behavior, not availability. Write it plainly: a single
  account is a single point of failure for this id; the only honest mitigation is
  client-side retry to a sibling id, which changes model semantics and is therefore not
  proposed as an automatic route.

### antigravity/gemini-3.7-flash-high — keep; reserves: 2 more accounts + cdx twin

- Main route: `antigravity/gemini-3.7-flash-high`; account fallback already exists
  (3 active accounts, priorities 1→2→3, all healthy) and is the primary reserve.
- Observed 24h: 21 req, 21 ok (100%), p50 9.3s, p95 21.5s, TTFT 5.6s, TPS 132.6.
- Cross-provider reserve candidate: `cdx/gemini-3.7-flash-high` — identical `root`
  (`gemini-3.7-flash-high`), owned by the active `cdx` compatible connection
  (`2550826b-c911-4f5c-a55c-9c721a585ed7`, testStatus active). Not live-probed →
  confirmation wave required before use as a default.

### antigravity/gemini-3.8-flash-tiered — keep; account reserves only

- Main route: `antigravity/gemini-3.8-flash-tiered`; account fallback across the same
  3 accounts.
- Observed 24h: 137 req, 135 ok (98.5%), p50 13.5s, p95 103s, TTFT 19.4s, TPS 67.6 —
  the slow tiered profile is real traffic, not a probe artifact (matches the D3 85 s
  deadline observation at `code_fix`).
- Cross-provider reserve: **no exact-root twin.** `cdx`/`bai` serve `gemini-3.8-flash`
  (root `gemini-3.8-flash`), a name-variant, not the same canonical id — listed as an
  unverified candidate only; do not silently substitute it.
- Note: bare `antigravity/gemini-3.8-flash` shows 3 req / 0 ok in 24h — do not route
  there without a dedicated investigation.

### antigravity/claude-sonnet-4-6 — keep; reserves: 2 more accounts + dva twin

- Main route: `antigravity/claude-sonnet-4-6`; account fallback across the 3 accounts.
- Observed 24h: 17 req, 17 ok (100%), p50 6.9s, p95 10.3s, TTFT 1.35s, TPS 18.5.
- Cross-provider reserve candidate: `dva/claude-sonnet-4-6` — identical `root`
  (`claude-sonnet-4-6`), 200k context vs 1M on antigravity, `supportsThinking: false`.
  **Caveat: no active `dva` (devin-cli-agentic) connection is visible in
  `/api/providers`** — the id exists in the catalog but nothing confirms it can serve
  today. Treat as catalog-only; verify the connection before it can be called a reserve.

## What would change if approved (not applied)

1. No combo is created or edited by default. If a stable explicit-model route is wanted,
   the minimal form is a `priority`-strategy combo per model whose targets are the main
   route followed by its confirmed reserves (account order + cross-provider twin), so a
   client can opt in without changing default routing.
2. Before any such combo: one confirmation wave (≤4 short requests) against each
   cross-provider candidate with a confirmed active connection (`cdx/gemini-3.7-flash-high`;
   `dva/claude-sonnet-4-6` only after its connection is verified) using the same D3
   probe, recorded in `model-quality-results`.
3. Account priorities (1/2/3) and `autoDisable` policy stay untouched; no paid tier is
   changed; no consumption limit is changed. Anything beyond that scope needs a separate
   approval.

## Follow-ups (explicitly open)

- Separate diagnostic traffic from user statistics with a dedicated test API key id
  (approval pending) — the 24h numbers above currently include the D3 probes.
- Repeat probe waves / 24h monitoring: separate agreement.
