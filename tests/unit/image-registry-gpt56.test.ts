import test from "node:test";
import assert from "node:assert/strict";

import { IMAGE_PROVIDERS, parseImageModel } from "../../open-sse/config/imageRegistry.ts";

test("retired common ChatGPT Web models stay absent from the image catalog and bare scan", () => {
  assert.equal(IMAGE_PROVIDERS["chatgpt-web"], undefined);
  assert.deepEqual(parseImageModel("cgpt-web/gpt-5.5"), {
    provider: null,
    model: "cgpt-web/gpt-5.5",
  });
  assert.deepEqual(parseImageModel("gpt-5.5"), {
    provider: null,
    model: "gpt-5.5",
  });
});

test("Codex image catalog exposes GPT Image 2 and the GPT-5.6 models", () => {
  assert.deepEqual(IMAGE_PROVIDERS.codex.models, [
    { id: "gpt-image-2", name: "GPT Image 2 (Codex OAuth)", inputModalities: ["text", "image"] },
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol (Codex Image)" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra (Codex Image)" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna (Codex Image)" },
  ]);

  assert.deepEqual(parseImageModel("gpt-image-2"), { provider: "codex", model: "gpt-image-2" });
  assert.deepEqual(parseImageModel("cx/gpt-image-2"), { provider: "codex", model: "gpt-image-2" });
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.deepEqual(parseImageModel(`cx/${model}`), { provider: "codex", model });
  }
});
