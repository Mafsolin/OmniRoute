import { SQLITE_FILE } from "../db/core";
import { createUsageStatsReader, type UsageStatsReader } from "./usage-stats-reader.cjs";

// Both latency and dashboard aggregation share one bounded, read-only worker.
// In-memory/cloud storage is intentionally unsupported: never silently run heavy
// SQL in the serving thread when the reader is unavailable or fails.
let instance: UsageStatsReader | null = null;
export function getUsageStatsReader(): UsageStatsReader {
  if (!SQLITE_FILE) throw new Error("Usage statistics require a SQLite file");
  instance ??= createUsageStatsReader(SQLITE_FILE);
  return instance;
}

export async function closeUsageStatsReaderForTest(): Promise<void> {
  const current = instance;
  instance = null;
  await current?.close();
}
