---
title: "Model quality probe results (D3)"
---

# Model quality probe results — bounded synthetic live runs

Generated: 2026-10-08T10:18:18.417062+00:00 • Probe: `scripts/ops/model-quality-probe.py` • Base: `https://api.mafsolin.space`

Objective smoke checks per case (strict JSON shape, duplicate-preserving sort, synthetic facts with negation, word count / long-context recall / code edge cases). Live budget respected: one model per run first, concurrency=1; failed runs kept below.

| case | model | max_out | status | smoke | finish | first_text_s | span_s | max_gap_s | completion | reasoning | visible_tps | reported_tps | route_model |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| json_probe | antigravity/claude-sonnet-4-6 | 768 | 200 | PASS | stop | 4.966 | 4.958 | 0.994 | 214 | — | — | 43.2 | claude-sonnet-4-6 |
| json_probe | antigravity/gemini-3.7-flash-high | 768 | 200 | PASS | stop | 12.73 | 0.014 | 0.011 | 3699 | 3482 | — | — | gemini-3.7-flash-tiered |
| json_probe | antigravity/gemini-3.8-flash-tiered | 768 | 200 | PASS | stop | 26.752 | 1.055 | 1.055 | 3498 | 3324 | 165.0 | 3316.2 | gemini-3.8-flash-tiered |
| code_fix | antigravity/claude-sonnet-4-6 | 768 | 200 | PASS | stop | 6.327 | 0.009 | 0.009 | 76 | — | — | — | claude-sonnet-4-6 |
| code_fix | opencode-go/deepseek-flash | 4096 | 200 | PASS | stop | 24.263 | 0.223 | 0.223 | 2621 | — | — | — | deepseek-flash |
| code_fix | opencode-go/deepseek-flash | 768 | 200 | FAIL | length | — | 0.0 | 0.0 | 768 | — | — | — | deepseek-flash |
| json_probe | opencode-go/deepseek-flash | 4096 | 200 | PASS | stop | 15.582 | 2.325 | 1.044 | 1132 | — | — | 486.9 | deepseek-flash |
| long_context | opencode-go/deepseek-flash | 4096 | 200 | PASS | stop | 6.444 | 0.736 | 0.722 | 66 | — | — | 89.7 | deepseek-flash |
| json_probe | opencode-go/deepseek-flash | 768 | 200 | FAIL | length | — | 0.0 | 0.0 | 768 | — | — | — | deepseek-flash |

## Observations

- **Known reasoning-only limit (deepseek-flash):** with `max_tokens=768` the whole budget was consumed by reasoning (`finish_reason=length`, zero visible text, `json_only=false`). The same cases pass with `max_output=4096`. This is the documented DeepSeek reasoning-only behavior — do not present the 768 runs as model failures, and do not lower real clients' limits to "fix" it.
- **visible_tps=None** everywhere reasoning usage was not reported — by design; only `reported_output_tps` (may include reasoning) was available.
- **tool_advertised: SKIP** — capability discovery lives in the catalog; the probe skips explicitly instead of faking a tool round-trip.
- Diagnostic requests are not separated from user statistics by a dedicated test API key id yet (approval pending); repeat waves and 24h monitoring separate.
