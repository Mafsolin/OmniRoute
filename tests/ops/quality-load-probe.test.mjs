import test from 'node:test';
import assert from 'node:assert/strict';
import * as probe from '../../scripts/ops/quality-load-probe.mjs';
const { inspectResponse } = probe;

const frame = (payload) => `data: ${JSON.stringify(payload)}\r\n\r\n`;

test('stage identity refuses production, wrong data directory and nonready units', () => {
  assert.equal(typeof probe.assertStageIdentity, 'function', 'stage guard must exist');
  const identity = { baseUrl: 'http://127.0.0.1:20138', unitActiveState: 'active', unitEnvironment:
    'DATA_DIR=/opt/omniroute-quality-speed-stage-data HOST=127.0.0.1 PORT=20138 DASHBOARD_PORT=20138 OMNIROUTE_DISABLE_BACKGROUND_SERVICES=1 OMNIROUTE_E2E_BOOTSTRAP_MODE=open' };
  assert.doesNotThrow(() => probe.assertStageIdentity(identity));
  assert.throws(() => probe.assertStageIdentity({ ...identity, baseUrl: 'https://api.mafsolin.space' }), /staging/);
  assert.throws(() => probe.assertStageIdentity({ ...identity, unitEnvironment: identity.unitEnvironment.replace('stage-data', 'data') }), /DATA_DIR/);
  assert.throws(() => probe.assertStageIdentity({ ...identity, unitActiveState: 'failed' }), /ready/);
});

test('owned synthetic provider is activated explicitly, read back by exact id and removed on failure', async () => {
  assert.equal(typeof probe.withSyntheticProvider, 'function', 'verified lifecycle must exist');
  let node;
  let connection;
  const reads = [];
  const writes = [];
  const api = async (path, method = 'GET', body) => {
    writes.push({ path, method, body });
    if (path === '/api/provider-nodes' && method === 'POST') { node = { id: 'openai-compatible-chat-owned', ...body }; return { node }; }
    if (path === '/api/provider-nodes' && method === 'GET') { reads.push(path); return { nodes: node ? [node] : [] }; }
    if (path === '/api/providers' && method === 'POST') { connection = { id: 'owned-connection', ...body, isActive: false, providerSpecificData: { ...body.providerSpecificData, baseUrl: node.baseUrl } }; return { connection }; }
    if (path === '/api/providers/owned-connection' && method === 'PUT') { Object.assign(connection, body); return { connection }; }
    if (path === '/api/providers/owned-connection' && method === 'GET') { reads.push(path); return { connection }; }
    if (path === '/api/providers' && method === 'GET') { reads.push(path); return { connections: connection ? [connection] : [] }; }
    if (path === '/api/provider-nodes/openai-compatible-chat-owned' && method === 'DELETE') { node = undefined; connection = undefined; return { success: true }; }
    throw new Error(`unhandled ${method} ${path}`);
  };
  await assert.rejects(probe.withSyntheticProvider({ api, upstreamBaseUrl: 'http://127.0.0.1:22222/v1' }, async ({ model, connectionId }) => {
    assert.match(model, /^f2-[a-f0-9]+\/probe-model$/);
    assert.equal(connectionId, 'owned-connection');
    assert.equal(connection.isActive, true);
    assert.equal(connection.maxConcurrent, 16);
    assert.equal(connection.providerSpecificData.autoFetchModels, false);
    throw new Error('deliberate wave failure');
  }), /deliberate wave failure/);
  assert.equal(node, undefined);
  assert.equal(connection, undefined);
  assert.ok(reads.includes('/api/providers/owned-connection'));
  assert.ok(reads.filter(p => p === '/api/provider-nodes').length >= 2);
  assert.ok(reads.includes('/api/providers'));
  assert.equal(writes.filter(w => w.method === 'DELETE').length, 1);
});

test('real loopback waves measure health during 1/4/8 slow streams and release aborted slots', { timeout: 20_000 }, async () => {
  assert.equal(typeof probe.createSyntheticUpstream, 'function', 'synthetic upstream must exist');
  assert.equal(typeof probe.runWave, 'function', 'concurrent probe must exist');
  const upstream = await probe.createSyntheticUpstream({ delayMs: 200 });
  try {
    for (const concurrency of [1, 4, 8]) {
      const wave = await probe.runWave({ baseUrl: upstream.origin, model: 'probe-model', concurrency, scenario: 'slow',
        upstream, samplePaths: ['/healthz'], requestTimeoutMs: 4000, sampleIntervalMs: 20 });
      assert.equal(wave.requests.length, concurrency);
      assert.ok(wave.samples.some(s => s.upstreamActiveAtStart > 0 && s.inFlightAtEnd > 0));
      assert.equal(wave.finalUpstreamActive, 0);
      assert.equal(wave.peakUpstreamActive, concurrency);
      for (const result of wave.requests) {
        assert.equal(result.outcome, 'completed');
        assert.equal(result.text, 'Ответ 🌿 без дублей.');
        assert.deepEqual(result.models, ['probe-model']);
        assert.ok(result.firstTextMs > result.firstEventMs);
      }
    }
    const aborted = await probe.runWave({ baseUrl: upstream.origin, model: 'probe-model', concurrency: 4, scenario: 'abort',
      upstream, samplePaths: ['/healthz'], requestTimeoutMs: 4000, sampleIntervalMs: 20 });
    assert.equal(aborted.finalUpstreamActive, 0);
    assert.equal(aborted.upstreamRequests.filter(r => r.disconnected).length, 4);
    assert.ok(aborted.requests.every(r => r.outcome === 'client_abort' && r.text === 'Ответ 🌿'));
    const restarted = await probe.runWave({ baseUrl: upstream.origin, model: 'probe-model', concurrency: 1, scenario: 'slow',
      upstream, samplePaths: ['/healthz'], requestTimeoutMs: 4000, sampleIntervalMs: 20 });
    assert.equal(restarted.requests[0].outcome, 'completed');
  } finally { await upstream.stop(); }
});
function response(source) {
  const bytes = new TextEncoder().encode(source);
  return new Response(new ReadableStream({ start(c) {
    for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
    c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('wave assessment rejects false success, identity changes, duplicates and missing health overlap', async () => {
  assert.equal(typeof probe.assessWave, 'function', 'semantic wave gate must exist');
  const upstream = await probe.createSyntheticUpstream({ delayMs: 200 });
  try {
    for (const scenario of ['429', '500', 'early-eof', 'stream-error', 'tool']) {
      const wave = await probe.runWave({ baseUrl: upstream.origin, model: 'probe-model', concurrency: 1, scenario, upstream,
        samplePaths: ['/healthz'], requestTimeoutMs: 4000, sampleIntervalMs: 20 });
      assert.deepEqual(probe.assessWave(wave, { paths: ['/healthz'] }).failures, []);
      const bad = structuredClone(wave);
      if (scenario === 'early-eof' || scenario === 'stream-error') {
        bad.requests[0].outcome = 'completed';
        assert.ok(probe.assessWave(bad, { paths: ['/healthz'] }).failures.some(f => /outcome/.test(f)));
        bad.requests[0].outcome = wave.requests[0].outcome;
      }
      if (scenario === 'tool') {
        bad.requests[0].toolCalls[0].arguments += '{"x":1}';
        assert.ok(probe.assessWave(bad, { paths: ['/healthz'] }).failures.some(f => /tool/.test(f)));
        bad.requests[0].toolCalls = wave.requests[0].toolCalls;
      }
      bad.requests[0].models = ['different-model'];
      assert.ok(probe.assessWave(bad, { paths: ['/healthz'] }).failures.some(f => /model/.test(f)));
      bad.requests[0].models = ['probe-model'];
      bad.samples = [];
      assert.ok(probe.assessWave(bad, { paths: ['/healthz'] }).failures.some(f => /overlap/.test(f)));
    }
  } finally { await upstream.stop(); }
});

test('Playwright setup refuses a production URL before login or network', async () => {
  assert.equal(typeof probe.default, 'function', 'scoped global setup must exist');
  await assert.rejects(probe.default({ projects: [{ use: { baseURL: 'https://api.mafsolin.space' } }] }), /staging/);
});

test('stage orchestration persists BLOCKED instead of inventing load results when unit is failed', async () => {
  assert.equal(typeof probe.runStageProbe, 'function', 'stage orchestrator must exist');
  const report = await probe.runStageProbe({ readIdentity: () => ({ baseUrl: 'http://127.0.0.1:20138', unitActiveState: 'failed',
    unitEnvironment: 'DATA_DIR=/opt/omniroute-quality-speed-stage-data HOST=127.0.0.1 PORT=20138 DASHBOARD_PORT=20138 OMNIROUTE_DISABLE_BACKGROUND_SERVICES=1 OMNIROUTE_E2E_BOOTSTRAP_MODE=open' }) });
  assert.equal(report.mode, 'staging-gateway');
  assert.equal(report.status, 'blocked');
  assert.equal(report.waves.length, 0);
  assert.match(report.blocker, /not ready/);
});

test('fragmented UTF-8 SSE preserves exact text and model identity', async () => {
  const result = await inspectResponse(response(': heartbeat\r\n\r\n' +
    frame({ model: 'probe-model', choices: [{ delta: { role: 'assistant' } }] }) +
    frame({ model: 'probe-model', choices: [{ delta: { content: 'Ответ 🌿' } }] }) +
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\r\n\r\n'));
  assert.equal(result.text, 'Ответ 🌿');
  assert.deepEqual(result.models, ['probe-model']);
  assert.equal(result.outcome, 'completed');
});

test('early EOF preserves partial output and never becomes completed', async () => {
  const result = await inspectResponse(response(frame({ choices: [{ delta: { content: 'partial' } }] })));
  assert.equal(result.text, 'partial');
  assert.equal(result.outcome, 'stream_truncated');
  assert.equal(result.terminal, false);
});

test('in-stream failure retains partial text and stays an error after DONE', async () => {
  const result = await inspectResponse(response(frame({ choices: [{ delta: { content: 'partial' } }] }) +
    frame({ error: { message: 'synthetic failure', code: 'upstream_error' } }) + 'data: [DONE]\r\n\r\n'));
  assert.equal(result.text, 'partial');
  assert.equal(result.outcome, 'upstream_error');
  assert.equal(result.error, 'synthetic failure');
});

test('reasoning is not first text; tool arguments, usage and length stay explicit', async () => {
  let clock = 0;
  const source = ': heartbeat\r\n\r\n' + frame({ choices: [{ delta: { reasoning_content: 'thinking' } }] }) +
    frame({ choices: [{ delta: { content: 'visible', tool_calls: [{ index: 0, id: 'tool-1', type: 'function', function: { name: 'dummy', arguments: '{"x":' } }] } }] }) +
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'length' }],
      usage: { prompt_tokens: 4, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 6 } } }) + 'data: [DONE]\r\n\r\n';
  const result = await inspectResponse(response(source), { startedAt: 0, now: () => ++clock });
  assert.equal(result.reasoning, 'thinking');
  assert.ok(result.firstTextMs > result.firstEventMs);
  assert.deepEqual(result.toolCalls, [{ index: 0, id: 'tool-1', name: 'dummy', arguments: '{"x":1}' }]);
  assert.deepEqual(result.finishReasons, ['length']);
  assert.equal(result.usage.completion_tokens, 9);
  assert.equal(result.outcome, 'completed');
});

test('client abort stays distinct and retains delivered text', async () => {
  const controller = new AbortController();
  const body = new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { content: 'partial' } }] })));
    setTimeout(() => { controller.abort(); c.error(controller.signal.reason); }, 10);
  } });
  const result = await inspectResponse(new Response(body), { signal: controller.signal })
    .catch(() => ({ outcome: 'unclassified' }));
  assert.equal(result.outcome, 'client_abort');
  assert.equal(result.text, 'partial');
  assert.equal(result.terminal, false);
});

test('unfinished frames have a byte bound', async () => {
  const result = await inspectResponse(response('data: ' + 'x'.repeat(100)), { maxFrameBytes: 32 });
  assert.equal(result.outcome, 'protocol_error');
  assert.match(result.error, /limit/);
});

test('HTTP 429 and 500 classify as errors and preserve Retry-After', async () => {
  for (const status of [429, 500]) {
    const result = await inspectResponse(new Response(JSON.stringify({ error: { message: 'synthetic HTTP error' } }),
      { status, headers: { 'retry-after': '2', 'content-type': 'application/json' } }));
    assert.equal(result.outcome, 'http_error');
    assert.equal(result.status, status);
    assert.equal(result.retryAfter, '2');
    assert.equal(result.error, 'synthetic HTTP error');
  }
});
