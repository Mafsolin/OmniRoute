import test from 'node:test';
import assert from 'node:assert/strict';
import * as metadata from '../../src/lib/modelMetadataRegistry.ts';
import { createModelCapabilityResolutionSnapshot } from '../../src/lib/modelCapabilityResolutionSnapshot.ts';
import { setModelContextOverride } from '../../src/lib/db/modelContextOverrides.ts';

// RED uses the existing resolver if the factory is not implemented: the assertion
// catches repeated scans rather than an import or missing-export failure.
const factory = (snapshot: ReturnType<typeof createModelCapabilityResolutionSnapshot>) =>
  typeof metadata.createBuildLocalCanonicalMetadataResolver === 'function'
    ? metadata.createBuildLocalCanonicalMetadataResolver(snapshot)
    : (input: { provider: string; model: string }) => metadata.getCanonicalModelMetadata({ ...input, snapshot });

test('build-local canonical metadata reuses a snapshot without rescanning and returns independent results', () => {
  const snapshot = createModelCapabilityResolutionSnapshot();
  let reads = 0;
  const synced = snapshot.synced;
  const instrumented = { ...snapshot, synced: new Proxy(synced, {
    get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
  }) };
  const resolve = factory(instrumented);
  const input = { provider: 'opencode-go', model: 'deepseek-flash' };
  const first = resolve(input)!;
  assert.ok(first);
  const firstReads = reads;
  assert.ok(firstReads > 0, 'the initial resolution must inspect snapshot data');
  const second = resolve(input)!;
  assert.deepEqual(second, first);
  assert.equal(reads, firstReads, 'the same build-local model must not rescan the synced snapshot');
  first.capabilities.reasoning = !first.capabilities.reasoning;
  first.aliases.push('caller-mutation');
  assert.deepEqual(resolve(input), second, 'memo hits must not expose mutable cached metadata');
});

test('a new build sees context edits while an old immutable snapshot stays coherent', () => {
  const provider = 'omni-metadata-memo-fixture';
  const model = 'unique-fixture-model';
  setModelContextOverride(provider, model, 11111, 'manual');
  const oldResolve = factory(createModelCapabilityResolutionSnapshot());
  const old = oldResolve({ provider, model });
  assert.equal(old?.limits.contextWindow, 11111);
  setModelContextOverride(provider, model, 22222, 'manual');
  const newResolve = factory(createModelCapabilityResolutionSnapshot());
  assert.equal(newResolve({ provider, model })?.limits.contextWindow, 22222);
  assert.equal(oldResolve({ provider, model })?.limits.contextWindow, 11111);
});
