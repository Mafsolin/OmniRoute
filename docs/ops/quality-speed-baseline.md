---
title: "Quality & Speed Baseline (2026-10-07)"
---

# Baseline: quality/speed work

## Verified scope

- Repository: https://github.com/Mafsolin/OmniRoute (public, owner account verified).
- Original source HEAD: 8bb49dd83; independent branch perf/quality-speed-20261007.
- Production runtime unchanged: /opt/omniroute-staging/runtime-c511facdf.
- Installed dependencies reused via symlink after comparing package.json and lockfile byte hashes; no installation into original source.
- Baseline targeted Node suite: 31 tests, 30 passed, 1 failed, 0 skipped. Existing latency-stats-ttft-6875 expected TPS 64.06 but current fixture computes 70.31; investigate separately before claiming regressions.
- Default branch release/v3.8.51, not main. Previous private task commits reside above feat/opencode-zen-free-tier-gate; publication will preserve history in a new branch, without force-push or guessed merge.
- Production browser tool blocked: local browser /tabs endpoint HTTP500. HTTP downloads are not proof of hydration. Isolated Linux Chromium is available for staging checks.

## Runtime preservation

peer-stamp, timeouts, HTTP method/HEAD guards and systemd notifier match source byte-for-byte. Old server-ws contains a global SQL reader bootstrap needed only by prior compiled runtime patches; the new source SQL reader is lazy and self-contained. Do not copy that bootstrap into the new bundle without need.

## Packaging TDD

New regression omni-standalone-stats failed with assembled worker null before change. After adding a single extra-module inventory entry: 7/7 assembly/native/timeouts tests passed. Runtime workers still require full candidate smoke before deploy.

## Deployment files

`deploy/omni` stores reviewed, secret-free templates of earlier nginx static/gzip/HTTP2, log rotation and off-process integrity work. It is not an automatic installer, DB backup, or instruction to replace all server config. Preserve deployment-specific hostnames, rate limits and other systemd drop-ins. Current production settings (never full vacuum; bounded incremental reclamation) must be preserved independently of source commits.

## Known pre-existing failures (measured at 8bb49dd83, not regressions)

- `tests/unit` latency-stats-ttft-6875: expected TPS 64.06, fixture computes 70.31 (investigate separately before claiming regressions).
- `tests/integration/combo-matrix/ordered|fusion|quota-aware|weighted`: fixtures referenced `claude-3-5-sonnet-20241022`, which the router answers 410 for ("was shut down on 2025-10-28 and cannot be routed automatically"); modernized to `claude-sonnet-4.6` on this branch (D1), same failures reproduced at 8bb49dd83 before the change.
- `tests/integration/combo-matrix/context-relay-handoff` tests 1-2 (universal handoff write): fail identically at 8bb49dd83; tracked separately, not a delivery regression.

## Actual external Chromium baseline (VPS browser, not user PC)

Authenticated admin pages redirect to login as expected. Anonymous login rendered at desktop/mobile, zero pageerrors and no horizontal overflow. Useful-control timings including screenshot overhead were 14.4/13.0/17.3 s; do not call these PC hydration metrics or use them as comparable provider-page timings. Screenshots are outside git in /opt/omniroute-quality-speed-data/browser-baseline/. Logged-in production user/admin baseline remains blocked by the local browser tool HTTP500, and was not bypassed with a raw password.
