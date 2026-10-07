import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  sourceRoot,
  variants,
  deploymentOptions,
  prefixHarnesses,
} from "../helpers/omniPerformanceHarness.mjs";

test("source harness targets this checkout, not the original source tree", () => {
  assert.equal(sourceRoot, fileURLToPath(new URL("../../", import.meta.url)));
});
for (const kind of variants) {
  const options = kind === "deployment" ? deploymentOptions : {};
  test(
    kind + ": catalog provider prefixes are scanned once per immutable alias snapshot",
    options,
    () => {
      for (const h of prefixHarnesses(kind)) {
        const first = Array.from(h.lookup(h.maps, "antigravity", "ag"));
        assert.deepEqual(first, ["antigravity", "ag"], h.name);
        const before = h.counters();
        for (let i = 0; i < 80; i++)
          assert.deepEqual(Array.from(h.lookup(h.maps, "antigravity", "ag")), first);
        assert.deepEqual(
          h.counters(),
          before,
          "repeated combo targets must not rescan aliases or reparse prefixes: " + h.name
        );
      }
    }
  );
  test(
    kind + ": prefix memo respects provider, raw alias, fresh snapshot and caller mutation",
    options,
    () => {
      for (const h of prefixHarnesses(kind)) {
        h.lookup(h.maps, "antigravity", "ag").push("invalid");
        assert.deepEqual(Array.from(h.lookup(h.maps, "antigravity", "ag")), ["antigravity", "ag"]);
        assert.deepEqual(Array.from(h.lookup(h.maps, "codex", "cx")), ["codex", "cx"]);
        assert.deepEqual(Array.from(h.lookup(h.maps, "antigravity", "antigravity")), [
          "antigravity",
          "ag",
        ]);
        const newMaps = {
          aliasToProviderId: { ag: "new-provider", antigravity: "antigravity" },
          providerIdToAlias: { antigravity: "antigravity" },
        };
        assert.deepEqual(
          Array.from(h.lookup(newMaps, "antigravity", "antigravity")),
          ["antigravity"],
          "new alias snapshots must not reuse old entries: " + h.name
        );
      }
    }
  );
}
