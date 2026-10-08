#!/usr/bin/env python3
"""E2: analyze catalog CPU profiles (new vs old) and look for duplicate scans.

Usage: python3 e2-analyze.py NEW.cpuprofile [OLD.cpuprofile]
Prints top self-time functions and catalog-scope aggregates.
"""
import json
import sys
from collections import defaultdict

SCOPE_MARKERS = (
    "catalog",
    "modelMetadataRegistry",
    "modelCapabilityResolutionSnapshot",
    "providers/registry",
)


def load(path):
    with open(path, encoding="utf-8") as fh:
        prof = json.load(fh)
    nodes = {n["id"]: n for n in prof["nodes"]}
    # self time: hitCount * sampling interval (µs) from samples/timeDeltas
    interval = 200  # matches Profiler.setSamplingInterval
    agg = defaultdict(lambda: {"self_us": 0, "samples": 0})
    samples = prof.get("samples", [])
    deltas = prof.get("timeDeltas", [])
    for i, node_id in enumerate(samples):
        node = nodes.get(node_id)
        if node is None:
            continue
        cf = node["callFrame"]
        name = cf.get("functionName") or "(anonymous)"
        url = cf.get("url", "")
        key = f"{name} @ {url.split('/')[-1]}"
        dt = deltas[i] if i < len(deltas) and deltas[i] > 0 else interval
        agg[key]["self_us"] += dt
        agg[key]["samples"] += 1
    return agg


def report(tag, agg, top=25):
    print(f"==== {tag}: top {top} by self time ====")
    for key, v in sorted(agg.items(), key=lambda kv: -kv[1]["self_us"])[:top]:
        print(f"{v['self_us']/1000.0:9.1f} ms  {v['samples']:5d}  {key}")
    total = sum(v["self_us"] for v in agg.values()) / 1000.0
    print(f"total sampled self time: {total:.0f} ms, frames: {len(agg)}")
    print()
    print(f"==== {tag}: catalog-scope aggregate ====")
    scope_us = 0
    for key, v in sorted(agg.items(), key=lambda kv: -kv[1]["self_us"]):
        if any(m in key for m in SCOPE_MARKERS):
            scope_us += v["self_us"]
            if v["self_us"] > 3000:
                print(f"{v['self_us']/1000.0:9.1f} ms  {v['samples']:5d}  {key}")
    print(f"catalog-scope total: {scope_us/1000.0:.0f} ms of {total:.0f} ms")
    print()
    # duplicate-scan heuristic: same function name from the same file appearing
    # under many different parents is fine; flag names that read like scans with
    # large cumulative self time for manual review.
    print(f"==== {tag}: scan-like hot frames ====")
    for key, v in sorted(agg.items(), key=lambda kv: -kv[1]["self_us"])[:120]:
        low = key.lower()
        if any(t in low for t in ("scan", "walk", "iterate", "collect", "resolve", "build", "filter", "map")):
            if v["self_us"] > 2000:
                print(f"{v['self_us']/1000.0:9.1f} ms  {v['samples']:5d}  {key}")


def main():
    new_path = sys.argv[1]
    old_path = sys.argv[2] if len(sys.argv) > 2 else None
    new_agg = load(new_path)
    report("NEW", new_agg)
    if old_path:
        old_agg = load(old_path)
        report("OLD", old_agg)
        print("==== delta: catalog-scope total ====")

        def scope_total(agg):
            return sum(v["self_us"] for k, v in agg.items() if any(m in k for m in SCOPE_MARKERS)) / 1000.0

        print(f"old: {scope_total(old_agg):.0f} ms -> new: {scope_total(new_agg):.0f} ms")
        print()
        print("==== functions that dropped out of the new top-60 ====")
        new_keys = set(k for k, _ in sorted(new_agg.items(), key=lambda kv: -kv[1]["self_us"])[:60])
        for key, v in sorted(old_agg.items(), key=lambda kv: -kv[1]["self_us"])[:60]:
            if key not in new_keys and v["self_us"] > 10000:
                print(f"old {v['self_us']/1000.0:9.1f} ms  {key}")


if __name__ == "__main__":
    main()
