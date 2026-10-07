export interface UsageStatsReader {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}
export function createUsageStatsReader(file: string): UsageStatsReader;
