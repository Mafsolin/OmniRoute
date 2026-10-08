# tests/ops/test_model_quality_probe.py
# stdlib unittest for scripts/ops/model-quality-probe.py — no live model calls.
#
# Runs against SAVED synthetic SSE payloads: fragmented byte boundaries
# (including a multi-byte UTF-8 character split across blocks), reasoning-only
# streams, usage provenance, terminal markers, mid-stream errors and the
# bounded line buffer.
#
#   python3 -m unittest discover -s tests/ops -p 'test_model_quality_probe.py' -v

import importlib.util
import json
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_SPEC = importlib.util.spec_from_file_location(
    "model_quality_probe", ROOT / "scripts" / "ops" / "model-quality-probe.py"
)
assert _SPEC and _SPEC.loader
probe = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(probe)


def sse(*events) -> bytes:
    out = b""
    for event in events:
        if isinstance(event, bytes):
            out += event
        else:
            # ensure_ascii=False so the payload carries RAW multi-byte UTF-8 —
            # the fragmentation test must split real UTF-8, not ASCII escapes.
            out += b"data: " + json.dumps(event, ensure_ascii=False).encode("utf-8") + b"\n\n"
    return out


def scan_bytes(chunks, timeout_s=85.0):
    return probe.consume_sse_stream(iter(chunks), time.monotonic(), timeout_s)


def delta(content=None, reasoning=None, finish=None):
    d = {}
    if content is not None:
        d["content"] = content
    if reasoning is not None:
        d["reasoning_content"] = reasoning
    ev = {"choices": [{"delta": d}]}
    if finish is not None:
        ev["choices"][0]["finish_reason"] = finish
    return ev


class FragmentedStreamTests(unittest.TestCase):
    def test_multibyte_character_split_across_blocks_survives(self):
        payload = sse(
            delta(content="Начало "),
            delta(content="🌿 середина "),
            delta(content="конец"),
            {"model": "m-1", "usage": {"completion_tokens": 30, "completion_tokens_details": {"reasoning_tokens": 10}}},
            b"data: [DONE]\n\n",
        )
        # Split at every single byte — worst-case fragmentation, incl. inside the
        # multi-byte emoji and the Cyrillic characters.
        chunks = [payload[i : i + 1] for i in range(len(payload))]
        scan = scan_bytes(chunks)
        self.assertEqual("".join(scan["text"]), "Начало 🌿 середина конец")
        self.assertTrue(scan["terminal"])
        self.assertEqual(scan["seen_model"], "m-1")
        self.assertEqual(scan["usage"]["completion_tokens"], 30)

    def test_reasoning_only_stream_has_no_visible_text(self):
        payload = sse(
            delta(reasoning="thinking..."),
            delta(reasoning=" still thinking"),
            delta(finish="stop"),
            b"data: [DONE]\n\n",
        )
        scan = scan_bytes([payload])
        self.assertEqual(scan["text"], [])
        self.assertIsNone(scan["first_text_s"])
        self.assertGreater(scan["reasoning_chars"], 0)
        self.assertEqual(scan["finish_reason"], "stop")

    def test_midstream_error_keeps_partial_text(self):
        payload = sse(
            delta(content="partial "),
            {"error": {"code": "upstream_reset", "message": "boom"}},
        )
        scan = scan_bytes([payload])
        self.assertEqual("".join(scan["text"]), "partial ")
        self.assertEqual(scan["error"], "upstream_reset")
        self.assertFalse(scan["terminal"])

    def test_bounded_line_buffer_trips_on_oversized_line(self):
        with self.assertRaises(ValueError):
            list(probe.iter_sse_lines(iter([b"x" * (probe.MAX_LINE_BUFFER + 10)])))

    def test_crlf_and_comments_are_ignored(self):
        raw = b": heartbeat\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n"
        scan = scan_bytes([raw])
        self.assertEqual("".join(scan["text"]), "ok")
        self.assertTrue(scan["terminal"])


class ThroughputHonestyTests(unittest.TestCase):
    def test_visible_tps_null_when_reasoning_unknown(self):
        got = probe.compute_throughput(completion=100, reasoning_tokens=None, span=10.0, text_chunks=5)
        self.assertIsNotNone(got["reported_output_tps_during_text"])
        self.assertIsNone(got["visible_tps_during_text"])

    def test_visible_tps_reported_when_reasoning_known(self):
        got = probe.compute_throughput(completion=100, reasoning_tokens=40, span=10.0, text_chunks=5)
        self.assertEqual(got["reported_output_tps_during_text"], 10.0)
        self.assertEqual(got["visible_tps_during_text"], 6.0)

    def test_unmeasurable_window_yields_nulls(self):
        got = probe.compute_throughput(completion=100, reasoning_tokens=40, span=0.1, text_chunks=5)
        self.assertIsNone(got["reported_output_tps_during_text"])
        self.assertIsNone(got["visible_tps_during_text"])
        got2 = probe.compute_throughput(completion=100, reasoning_tokens=40, span=10.0, text_chunks=1)
        self.assertIsNone(got2["reported_output_tps_during_text"])


class ObjectiveCheckTests(unittest.TestCase):
    def test_json_probe_perfect_body_passes_all_checks(self):
        body = json.dumps(
            {
                "marker": "ROUTE-CHECK-7",
                "sorted": [-3, 0, 2, 7, 7],
                "facts": ["Oleg owns the task", "The deadline is Monday", "Deployment has not occurred"],
                "note": " ".join(["policy"] * 110),
            }
        )
        checks = probe.objective_checks("json_probe", body)
        self.assertTrue(checks)
        self.assertTrue(all(checks.values()), checks)

    def test_json_probe_flags_wrong_owner_and_non_json(self):
        wrong = json.dumps(
            {
                "marker": "ROUTE-CHECK-7",
                "sorted": [-3, 0, 2, 7, 7],
                "facts": ["Nina owns the task", "Friday", "deployed"],
                "note": "too short",
            }
        )
        checks = probe.objective_checks("json_probe", wrong)
        self.assertFalse(checks["owner"])
        self.assertFalse(checks["deadline"])
        self.assertFalse(checks["note_word_count"])
        self.assertFalse(probe.objective_checks("json_probe", "not json")["json_only"])

    def test_long_context_checks(self):
        body = json.dumps({"owner": "Oleg", "deadline": "Monday", "deployed": False})
        checks = probe.objective_checks("long_context", body)
        self.assertTrue(all(checks.values()), checks)

    def test_tool_case_skips_explicitly(self):
        rec = probe.record_skip("tool capability not confirmed", "m-x", "tool_advertised")
        self.assertTrue(rec["skipped"])
        self.assertIsNone(rec["smoke_pass"])


class PromptBuilderTests(unittest.TestCase):
    def test_long_context_prompt_keeps_literal_json_braces(self):
        # Regression: str.format on the prompt treated {"owner": ...} as
        # placeholders (KeyError '"owner"') — the filler must be substituted
        # without touching the literal JSON example.
        prompt = probe.build_prompt("long_context")
        self.assertIn('"owner"', prompt)
        self.assertIn("Monday", prompt)
        self.assertIn(probe.FILLER_SENTENCE, prompt)
        self.assertNotIn("{fill}", prompt)

    def test_other_prompts_build(self):
        self.assertIn("ROUTE-CHECK-7", probe.build_prompt("json_probe"))
        self.assertIn("def f(xs)", probe.build_prompt("code_fix"))


if __name__ == "__main__":
    unittest.main()
