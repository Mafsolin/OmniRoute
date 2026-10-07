#!/usr/bin/env node
// Reuse the repository's stable per-file/per-code baseline gate; preserve raw logs.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseTscOutput, diffAgainstBaseline } from "./check-dashboard-typecheck.mjs";

export function compareQualitySpeedTypechecks(baseline, current, baselineExitCode, currentExitCode) {
  const before = parseTscOutput(baseline);
  const after = parseTscOutput(current);
  const { regressions, improvements } = diffAgainstBaseline(after, before);
  const count = (values) => Object.values(values).reduce((total, codes) => total + Object.values(codes).reduce((a, b) => a + b, 0), 0);
  const baselineComplete = [0, 2].includes(baselineExitCode);
  const currentComplete = [0, 2].includes(currentExitCode);
  return { baselineErrors: count(before), currentErrors: count(after), regressions, improvements, baselineComplete, currentComplete, passed: baselineComplete && currentComplete && regressions.length === 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [before, after, baselineCode, currentCode] = process.argv.slice(2);
  if (!before || !after || baselineCode === undefined || currentCode === undefined) {
    console.error("Usage: check-quality-speed-typecheck.mjs baseline.log current.log baselineExitCode currentExitCode");
    process.exitCode = 2;
  } else {
    const result = compareQualitySpeedTypechecks(fs.readFileSync(before, "utf8"), fs.readFileSync(after, "utf8"), Number(baselineCode), Number(currentCode));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  }
}
