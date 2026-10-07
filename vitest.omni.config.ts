import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/unit/ui/omni-*.test.tsx"],
    exclude: [],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
