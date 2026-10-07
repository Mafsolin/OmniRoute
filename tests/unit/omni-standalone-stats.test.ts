import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncStandaloneExtraModules } from '../../scripts/build/assembleStandalone.mjs';

test('standalone assembly preserves the read-only statistics worker sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omni-stats-assembly-'));
  const out = join(root, 'release');
  const worker = "'use strict'; module.exports = { createUsageStatsReader() {} };\n";
  try {
    await mkdir(join(root, 'src/lib/usage'), { recursive: true });
    await writeFile(join(root, 'src/lib/usage/usage-stats-reader.cjs'), worker);
    await syncStandaloneExtraModules(root, undefined, { log() {} }, out);
    const assembled = await readFile(join(out, 'usage-stats-reader.cjs'), 'utf8')
      .catch(() => null);
    assert.equal(assembled, worker, 'new standalone artifacts must preserve the SQL worker');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
