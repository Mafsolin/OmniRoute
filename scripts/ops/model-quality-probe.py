#!/usr/bin/env python3
"""Bounded synthetic model-quality probe for an OmniRoute gateway.

Purpose (quality/speed plan, D3): verify, per model, that a gateway response
that "works" still keeps the strict output contract, and separate first-text
latency from token throughput without needing a personal key on disk in the
wrong place:

  * the API key is read from an existing read-only SQLite api_keys item on the
    VPS and is NEVER printed, echoed or written to the report;
  * the SSE reader is bounded (fixed-size reads, capped line buffer) so an
    arbitrary chunk/UTF-8 boundary cannot corrupt or grow the stream payload;
  * first event / first reasoning / first text / last text / terminal marker /
    usage provenance / actual route model are recorded separately;
  * `visible_tps_*` is null whenever reasoning usage is unknown — callers must
    not present a reasoning-inflated number as visible throughput;
  * unsupported capabilities (tool cases) SKIP explicitly with a reason
    instead of faking a FAIL or vanishing from the report.

Live runs stay inside the approved budget: one model per run first
(concurrency=1), a separate concurrency=4 wave only on request.

Usage:
    python3 scripts/ops/model-quality-probe.py --model opencode-go/deepseek-flash \
        --case json_probe --report /tmp/probe.json
    python3 scripts/ops/model-quality-probe.py --all-models --case long_context

    python3 -m unittest discover -s tests/ops -p 'test_model_quality_probe.py' -v
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_BASE_URL = "https://api.mafsolin.space"
DEFAULT_DB = "/opt/omniroute-staging/data/storage.sqlite"
DEFAULT_KEY_NAME = "hermes"
DEFAULT_MAX_OUTPUT = 768
THINKING_MAX_OUTPUT = 4096
DEFAULT_TIMEOUT_S = 85
MAX_LINE_BUFFER = 1 << 20  # 1 MiB per SSE line, hard bound

DEFAULT_MODELS = [
    "opencode-go/deepseek-flash",
    "antigravity/gemini-3.7-flash-high",
    "antigravity/gemini-3.8-flash-tiered",
    "antigravity/claude-sonnet-4-6",
]

JSON_PROBE_PROMPT = """Synthetic gateway check. Output one JSON object only, no Markdown, with exactly these fields:
marker: the exact string ROUTE-CHECK-7
sorted: the numbers [7, -3, 7, 0, 2] sorted ascending without removing duplicates
facts: array of exactly three English strings. From the paragraph below state who owns the task, the final deadline and whether deployment has occurred. Do not invent details.
Paragraph: Nina was initially assigned as owner, but that assignment was explicitly cancelled and Oleg is the current owner. A draft proposed Friday; the approved deadline is Monday. Tests passed, but deployment has NOT occurred.
note: 100 to 130 English words explaining why a successful proxy response does not prove reliable model service and how to distinguish first-text latency from token throughput. Do not refer to this test's expected answer."""

LONG_CONTEXT_PROMPT = """Synthetic long-context check. Read the whole briefing below and answer with one JSON object only, no Markdown.

Briefing (opening): Owner for the migration is Oleg; the earlier owner Nina was cancelled. The approved deadline is Monday (a rejected draft said Friday). Deployment has NOT occurred.

[Middle filler — unrelated operational notes, intentionally repetitive]
{fill}

Briefing (closing): Repeat the three facts as JSON fields owner, deadline, deployed. The deadline is Monday, owner Oleg, and deployment has not occurred. Negations: not Nina, not Friday, not deployed.

Output exactly: {"owner": "...", "deadline": "...", "deployed": false}
"""

CODE_FIX_PROMPT = """Fix the bug in this Python function and reply with one JSON object only:
{"fixed": "<the corrected function as a string>", "case_empty": "<result of f([])>", "case_neg": "<result of f([-2])>"}

def f(xs):
    return min(xs) / len(xs)

The corrected function must return 0 for an empty list and must not divide by zero for [-2] (return xs[0] in that degenerate case)."""

FILLER_SENTENCE = "Routine note about DNS, backups and cache warmup that must not change any of the three facts. "


def build_prompt(case: str) -> str:
    if case == "json_probe":
        return JSON_PROBE_PROMPT
    if case == "long_context":
        # Literal JSON braces in the prompt must survive: str.format would treat
        # {"owner": ...} as placeholders, so substitute the filler explicitly.
        return LONG_CONTEXT_PROMPT.replace("{fill}", FILLER_SENTENCE * 400)
    if case == "code_fix":
        return CODE_FIX_PROMPT
    raise SystemExit(f"unknown case: {case}")


def load_api_key(db_path: str, key_name: str) -> str:
    """Read the key from a read-only SQLite handle. Never log the value."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3)
    try:
        row = conn.execute(
            "SELECT key FROM api_keys WHERE name = ? AND revoked_at IS NULL LIMIT 1",
            (key_name,),
        ).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        raise SystemExit(f"no active api key named {key_name!r} in {db_path}")
    return row[0]


def iter_sse_lines(byte_iter, max_buffer: int = MAX_LINE_BUFFER):
    """Split an arbitrarily fragmented byte stream into SSE lines, bounded.

    `byte_iter` yields raw byte blocks of any size (network reads), so a line
    or a UTF-8 character can be split at any boundary — both must survive.
    """
    buf = b""
    for block in byte_iter:
        buf += block
        if len(buf) > max_buffer:
            raise ValueError("sse line buffer exceeded bound")
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            yield line
    if buf:
        yield buf


def new_scan() -> dict:
    return {
        "first_event_s": None,
        "first_reasoning_s": None,
        "first_text_s": None,
        "last_text_s": None,
        "max_text_gap_s": 0.0,
        "text_chunks": 0,
        "text": [],
        "reasoning_chars": 0,
        "usage": None,
        "seen_model": None,
        "finish_reason": None,
        "terminal": False,
        "error": None,
    }


def consume_sse_stream(byte_iter, start: float, timeout_s: float) -> dict:
    """Consume one SSE byte stream into objective observations.

    Pure stream logic (no HTTP): the unit test drives this directly with a
    saved synthetic stream.
    """
    scan = new_scan()
    for raw_line in iter_sse_lines(byte_iter):
        now = time.monotonic()
        if now - start > timeout_s:
            scan["error"] = "overall_deadline"
            break
        line = raw_line.rstrip(b"\r")
        if not line or line.startswith(b":"):
            continue
        if not line.startswith(b"data:"):
            continue
        payload = line[5:].strip()
        if payload == b"[DONE]":
            scan["terminal"] = True
            break
        try:
            event = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            continue
        if scan["first_event_s"] is None:
            scan["first_event_s"] = now - start
        err = event.get("error")
        if isinstance(err, dict):
            scan["error"] = str(err.get("code") or err.get("message") or "stream_error")[:180]
        if isinstance(event.get("model"), str):
            scan["seen_model"] = event["model"]
        if isinstance(event.get("usage"), dict):
            scan["usage"] = event["usage"]
        for choice in event.get("choices") or []:
            delta = choice.get("delta") or {}
            reasoning = delta.get("reasoning_content")
            if reasoning is None:
                reasoning = delta.get("reasoning")
            if isinstance(reasoning, str) and reasoning:
                if scan["first_reasoning_s"] is None:
                    scan["first_reasoning_s"] = now - start
                scan["reasoning_chars"] += len(reasoning)
            content = delta.get("content")
            if isinstance(content, str) and content:
                if scan["first_text_s"] is None:
                    scan["first_text_s"] = now - start
                if scan["last_text_s"] is not None:
                    scan["max_text_gap_s"] = max(scan["max_text_gap_s"], now - start - scan["last_text_s"])
                scan["last_text_s"] = now - start
                scan["text_chunks"] += 1
                scan["text"].append(content)
            if choice.get("finish_reason") is not None:
                scan["finish_reason"] = choice["finish_reason"]
    return scan


def compute_throughput(completion, reasoning_tokens, span: float, text_chunks: int) -> dict:
    """Throughput facts, with the honesty rule applied in one place.

    reported_output_tps may include reasoning tokens. visible_tps is null
    whenever reasoning usage is unknown (or the window is not measurable) so a
    reasoning-inflated number can never be presented as visible throughput.
    """
    measurable = isinstance(completion, int) and span > 0.25 and text_chunks > 1
    visible = completion - reasoning_tokens if isinstance(completion, int) and isinstance(reasoning_tokens, int) else None
    return {
        "reported_output_tps_during_text": round(completion / span, 1) if measurable else None,
        "visible_tps_during_text": round(visible / span, 1) if (visible is not None and measurable) else None,
    }


def objective_checks(case: str, body: str) -> dict:
    """Objective assertions per case — never subjective preference."""
    checks: dict = {}
    try:
        parsed = json.loads(body)
        checks["json_only"] = True
    except (ValueError, TypeError):
        checks["json_only"] = False
        return checks
    if case == "json_probe":
        checks["keys"] = set(parsed) == {"marker", "sorted", "facts", "note"}
        checks["marker"] = parsed.get("marker") == "ROUTE-CHECK-7"
        checks["sorted"] = parsed.get("sorted") == sorted([7, -3, 7, 0, 2])
        facts = parsed.get("facts")
        fs = " ".join(map(str, facts)).lower() if isinstance(facts, list) else ""
        checks["facts_shape"] = isinstance(facts, list) and len(facts) == 3
        checks["owner"] = "oleg" in fs and "nina" not in fs
        checks["deadline"] = "monday" in fs and "friday" not in fs
        checks["deployment_not_occurred"] = (
            "not" in fs or "hasn't" in fs or "no deployment" in fs or "undeployed" in fs
        )
        note_words = len(str(parsed.get("note", "")).split())
        checks["note_word_count"] = 100 <= note_words <= 130
    elif case == "long_context":
        checks["keys"] = set(parsed) == {"owner", "deadline", "deployed"}
        checks["owner"] = str(parsed.get("owner", "")).lower() == "oleg"
        checks["deadline"] = str(parsed.get("deadline", "")).lower() == "monday"
        checks["deployed"] = parsed.get("deployed") is False
    elif case == "code_fix":
        checks["keys"] = set(parsed) == {"fixed", "case_empty", "case_neg"}
        checks["case_empty"] = str(parsed.get("case_empty")) in {"0", "0.0"}
        checks["case_neg"] = str(parsed.get("case_neg")) in {"-2", "-2.0"}
        checks["fixed_guards_len"] = "len(" in str(parsed.get("fixed", ""))
    return checks


def run_case(*, base_url: str, key: str, model: str, case: str, max_output: int, timeout_s: float) -> dict:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Follow the user instructions exactly."},
            {"role": "user", "content": build_prompt(case)},
        ],
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_tokens": max_output,
    }
    request = urllib.request.Request(
        base_url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    start = time.monotonic()
    out: dict = {"case": case, "requested_model": model, "request_options": {"max_tokens": max_output, "reasoning_override": False}}

    def stream_blocks(response, block_size: int = 4096):
        while True:
            block = response.read(block_size)
            if not block:
                return
            yield block

    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            out["status"] = response.status
            out["headers_s"] = round(time.monotonic() - start, 3)
            out["selected_connection_id"] = response.headers.get("x-omniroute-selected-connection-id")
            scan = consume_sse_stream(stream_blocks(response), start, timeout_s)
    except urllib.error.HTTPError as exc:
        out["status"] = exc.code
        scan = new_scan()
        try:
            err = json.loads(exc.read()).get("error", {})
            scan["error"] = str(err.get("code") or str(err.get("message"))[:160])[:180]
        except Exception:
            scan["error"] = "http_error"
    except Exception as exc:  # noqa: BLE001 - report, never raise mid-probe
        out["status"] = None
        scan = new_scan()
        scan["error"] = type(exc).__name__

    end = time.monotonic()
    body = "".join(scan["text"])
    usage = scan["usage"] if isinstance(scan["usage"], dict) else {}
    completion = usage.get("completion_tokens")
    details = usage.get("completion_tokens_details") or {}
    reasoning_tokens = details.get("reasoning_tokens")
    span = (
        scan["last_text_s"] - scan["first_text_s"]
        if scan["last_text_s"] is not None and scan["first_text_s"] is not None
        else 0.0
    )
    throughput = compute_throughput(completion, reasoning_tokens, span, scan["text_chunks"])

    out.update(
        {
            "total_s": round(end - start, 3),
            "first_sse_s": round(scan["first_event_s"], 3) if scan["first_event_s"] is not None else None,
            "first_reasoning_s": round(scan["first_reasoning_s"], 3) if scan["first_reasoning_s"] is not None else None,
            "first_text_s": round(scan["first_text_s"], 3) if scan["first_text_s"] is not None else None,
            "text_span_s": round(span, 3),
            "max_text_gap_s": round(scan["max_text_gap_s"], 3),
            "completion_tokens": completion,
            "reasoning_tokens": reasoning_tokens,
            # Never present reasoning-inflated throughput as visible TPS.
            "reported_output_tps_during_text": throughput["reported_output_tps_during_text"],
            "visible_tps_during_text": throughput["visible_tps_during_text"],
            "output_tokens_per_total_s": round(completion / (end - start), 1) if isinstance(completion, int) else None,
            "text_chunks": scan["text_chunks"],
            "characters": len(body),
            "reasoning_characters": scan["reasoning_chars"],
            "terminal": scan["terminal"],
            "finish_reason": scan["finish_reason"],
            "actual_route_model": scan["seen_model"],
            "error": scan["error"],
        }
    )
    checks = objective_checks(case, body)
    out["smoke_checks"] = checks
    out["smoke_pass"] = bool(checks) and all(checks.values())
    out["response"] = body
    return out


def record_skip(reason: str, model: str, case: str) -> dict:
    return {
        "case": case,
        "requested_model": model,
        "skipped": True,
        "skip_reason": reason,
        "smoke_pass": None,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--model", action="append", dest="models", default=[])
    parser.add_argument("--all-models", action="store_true", help="run every default model (concurrency=1)")
    parser.add_argument("--case", choices=["json_probe", "long_context", "code_fix", "tool_advertised"], default="json_probe")
    parser.add_argument("--max-output", type=int, default=None)
    parser.add_argument("--db", default=DEFAULT_DB, help="read-only SQLite api_keys location")
    parser.add_argument("--key-name", default=DEFAULT_KEY_NAME)
    parser.add_argument("--report", default=None, help="write JSON report to this path (never contains the key)")
    parser.add_argument("--concurrency", type=int, default=1)
    args = parser.parse_args(argv)

    if args.case == "tool_advertised":
        # Capability discovery lives in the catalog, not in this bounded probe;
        # SKIP explicitly instead of faking a failing tool round-trip.
        report = {
            "case": args.case,
            "results": [record_skip("tool capability not confirmed by this probe; see catalog capabilities", m, args.case) for m in (args.models or DEFAULT_MODELS)],
        }
    else:
        models = args.models or (DEFAULT_MODELS if args.all_models else DEFAULT_MODELS[:1])
        max_output = args.max_output if args.max_output is not None else (THINKING_MAX_OUTPUT if args.case == "long_context" else DEFAULT_MAX_OUTPUT)
        key = load_api_key(args.db, args.key_name)
        results = []
        if args.concurrency > 1:
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=min(args.concurrency, 4)) as pool:
                futures = [pool.submit(run_case, base_url=args.base_url, key=key, model=m, case=args.case, max_output=max_output, timeout_s=DEFAULT_TIMEOUT_S) for m in models]
                for future in concurrent.futures.as_completed(futures):
                    results.append(future.result())
        else:
            for model in models:
                results.append(run_case(base_url=args.base_url, key=key, model=model, case=args.case, max_output=max_output, timeout_s=DEFAULT_TIMEOUT_S))
        report = {
            "case": args.case,
            "base_url": args.base_url,
            "max_output": max_output,
            "concurrency": args.concurrency,
            "warning": "Short synthetic format/content smoke test, not a general quality benchmark. reported_output_tps may include reasoning; visible_tps is null unless reasoning usage is known.",
            "results": results,
        }

    text = json.dumps(report, indent=2, ensure_ascii=False)
    if args.report:
        Path(args.report).write_text(text + "\n", encoding="utf-8")
        summary = [{k: r.get(k) for k in ("case", "requested_model", "status", "smoke_pass", "error")} for r in report["results"]]
        print(json.dumps({"saved": args.report, "results": summary}, ensure_ascii=False, indent=2))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
