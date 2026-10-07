import { performance } from 'node:perf_hooks';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function inspectResponse(response, { startedAt = performance.now(), now = () => performance.now(), signal, maxFrameBytes = 1_048_576, onText } = {}) {
  const result = { status: response.status, retryAfter: response.headers.get('retry-after'),
    text: '', reasoning: '', models: [], terminal: false, outcome: 'unknown',
    firstEventMs: null, firstTextMs: null, totalMs: null, finishReasons: [], toolCalls: [], usage: null };
  if (!response.ok) {
    const data = await response.json();
    result.outcome = 'http_error';
    result.error = data.error?.message || `HTTP ${response.status}`;
    result.totalMs = now() - startedAt;
    return result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (source) => {
    signal?.throwIfAborted();
    const data = source.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { result.terminal = true; return; }
    const payload = JSON.parse(data);
    if (payload.error) { result.error = payload.error.message || 'upstream failed'; result.outcome = 'upstream_error'; }
    result.firstEventMs ??= now() - startedAt;
    if (payload.model && !result.models.includes(payload.model)) result.models.push(payload.model);
    const choice = payload.choices?.[0];
    const delta = choice?.delta || {};
    result.reasoning += delta.reasoning_content ?? delta.reasoning ?? '';
    if (payload.usage) result.usage = payload.usage;
    for (const item of delta.tool_calls || []) {
      const index = item.index ?? 0;
      let tool = result.toolCalls.find(t => t.index === index);
      if (!tool) { tool = { index, id: '', name: '', arguments: '' }; result.toolCalls.push(tool); }
      if (item.id) tool.id = item.id;
      if (item.function?.name) tool.name += item.function.name;
      tool.arguments += item.function?.arguments ?? '';
    }
    if (delta.content) {
      result.firstTextMs ??= now() - startedAt;
      result.text += delta.content;
      onText?.(delta.content);
    }
    if (choice?.finish_reason) { result.terminal = true; result.finishReasons.push(choice.finish_reason); }
    signal?.throwIfAborted();
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        if (Buffer.byteLength(buffer.slice(0, match.index)) > maxFrameBytes) throw new Error('SSE frame limit exceeded');
        consume(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) throw new Error('SSE frame limit exceeded');
      if (done) break;
    }
    if (result.outcome !== 'upstream_error') result.outcome = result.terminal && !buffer.trim() ? 'completed' : 'stream_truncated';
    return result;
  } catch (error) {
    result.outcome = signal?.aborted ? 'client_abort' : 'protocol_error';
    result.error = error.message;
    await reader.cancel().catch(() => {});
    return result;
  } finally {
    result.totalMs = now() - startedAt;
    reader.releaseLock();
  }
}

export async function createSyntheticUpstream({ delayMs = 200 } = {}) {
  const records = [];
  let active = 0;
  let peak = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': req.url === '/healthz' ? 'text/plain' : 'application/json' });
        res.end(req.url === '/healthz' ? 'ok\n' : JSON.stringify({ data: [{ id: 'probe-model', object: 'model' }] }));
        return;
      }
      let raw = '';
      for await (const bytes of req) {
        raw += bytes.toString('utf8');
        if (Buffer.byteLength(raw) > 65536) throw new Error('synthetic request limit exceeded');
      }
      const body = JSON.parse(raw);
      const marker = body.messages?.find(m => m.role === 'user')?.content ?? '';
      const scenario = /^F2:([^:]+):/.exec(marker)?.[1] ?? 'autotest';
      const record = { body, scenario, startedAt: performance.now(), endedAt: null, disconnected: false };
      records.push(record);
      active += 1;
      peak = Math.max(peak, active);
      const timers = [];
      res.once('close', () => {
        for (const timer of timers) clearTimeout(timer);
        active -= 1;
        record.endedAt = performance.now();
        record.disconnected = !res.writableFinished;
      });
      const schedule = (n, fn) => timers.push(setTimeout(() => { if (!res.destroyed) fn(); }, delayMs * n));
      const send = payload => {
        const bytes = Buffer.from(`data: ${JSON.stringify(payload)}\r\n\r\n`);
        for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
      };
      const chunk = delta => ({ id: 'chatcmpl-f2', object: 'chat.completion.chunk', created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason: null }] });
      if (scenario === 'autotest' || body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-f2-test', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }));
        return;
      }
      if (scenario === '429' || scenario === '500') {
        schedule(1, () => {
          res.writeHead(Number(scenario), { 'content-type': 'application/json', ...(scenario === '429' ? { 'retry-after': '2' } : {}) });
          res.end(JSON.stringify({ error: { message: `F2 synthetic ${scenario}`, type: 'synthetic_upstream_error', code: `f2_${scenario}` } }));
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      res.write(': heartbeat\r\n\r\n');
      send(chunk({ role: 'assistant' }));
      schedule(1, () => send(chunk({ reasoning_content: 'synthetic thinking' })));
      schedule(2, () => {
        if (scenario === 'tool') send(chunk({ tool_calls: [{ index: 0, id: 'call-f2', type: 'function', function: { name: 'dummy', arguments: '{"x":' } }] }));
        else send(chunk({ content: 'Ответ 🌿' }));
      });
      schedule(3, () => {
        if (scenario === 'abort') return;
        if (scenario === 'early-eof') { res.end(); return; }
        if (scenario === 'stream-error') { send({ error: { message: 'F2 synthetic midstream failure', code: 'upstream_error' } }); res.end('data: [DONE]\r\n\r\n'); return; }
        if (scenario === 'tool') send(chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }));
        else send(chunk({ content: ' без' }));
      });
      schedule(4, () => { if (scenario !== 'tool' && scenario !== 'abort') send(chunk({ content: ' дублей.' })); });
      schedule(scenario === 'abort' ? 100 : 5, () => {
        send({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: scenario === 'tool' ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 9, total_tokens: 13, completion_tokens_details: { reasoning_tokens: 6 } } });
        res.end('data: [DONE]\r\n\r\n');
      });
    })().catch(error => {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, baseUrl: `${origin}/v1`, records,
    snapshot: () => ({ active, peak }), resetPeak: () => { peak = active; },
    stop: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export async function runWave({ baseUrl, model, concurrency, scenario, upstream,
  samplePaths = ['/healthz', '/api/providers', '/api/settings'], requestTimeoutMs = 30_000,
  sampleIntervalMs = 100, sampleTimeoutMs = 2000,
}) {
  if (![1, 4, 8].includes(concurrency)) throw new Error('allowed concurrency: 1, 4, 8');
  const marker = `F2:${scenario}:${randomUUID()}`;
  const recordStart = upstream.records.length;
  upstream.resetPeak();
  let inFlight = 0;
  const samples = [];
  const requests = Array.from({ length: concurrency }, async (_, index) => {
    const controller = new AbortController();
    const startedAt = performance.now();
    const deadline = setTimeout(() => controller.abort(new Error('request deadline')), requestTimeoutMs);
    let abortTimer;
    let result;
    inFlight += 1;
    const body = { model, stream: true, stream_options: { include_usage: true }, reasoning_effort: 'high', max_tokens: 4096,
      temperature: 0.7, messages: [{ role: 'system', content: 'Keep synthetic instructions and reasoning effort.' },
        { role: 'user', content: `${marker}:${index}` }],
      ...(scenario === 'tool' ? { tools: [{ type: 'function', function: { name: 'dummy', description: 'Synthetic only; never executed',
        parameters: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'], additionalProperties: false } } }] } : {}),
    };
    try {
      const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
      });
      result = await inspectResponse(response, { startedAt, signal: controller.signal, onText: () => {
        if (scenario === 'abort') controller.abort(new Error('intentional client abort'));
      } });
      if (controller.signal.aborted && controller.signal.reason?.message === 'request deadline') result.outcome = 'deadline';
    } catch (error) {
      result = { status: null, outcome: controller.signal.aborted ? 'deadline' : 'transport_error', error: error.message,
        text: '', terminal: false, models: [], firstEventMs: null, firstTextMs: null, totalMs: performance.now() - startedAt };
    } finally {
      inFlight -= 1;
      clearTimeout(deadline);
      clearTimeout(abortTimer);
    }
    return { index, requestedModel: model, ...result };
  });
  const sampling = (async () => {
    while (inFlight > 0) {
      await Promise.all(samplePaths.map(async path => {
        const startedAt = performance.now();
        const inFlightAtStart = inFlight;
        const upstreamActiveAtStart = upstream.snapshot().active;
        let status = null;
        let error = null;
        try {
          const response = await fetch(`${baseUrl}${path}`, { redirect: 'error', signal: AbortSignal.timeout(sampleTimeoutMs) });
          status = response.status;
          await response.arrayBuffer();
        } catch (failure) { error = failure.message; }
        samples.push({ path, status, error, ms: performance.now() - startedAt, inFlightAtStart, inFlightAtEnd: inFlight,
          upstreamActiveAtStart, upstreamActiveAtEnd: upstream.snapshot().active });
      }));
      if (inFlight > 0) await delay(sampleIntervalMs);
    }
  })();
  const results = await Promise.all(requests);
  await sampling;
  const releaseDeadline = performance.now() + 1000;
  while (upstream.snapshot().active && performance.now() < releaseDeadline) await delay(20);
  const { active: finalUpstreamActive, peak: peakUpstreamActive } = upstream.snapshot();
  return { concurrency, scenario, requests: results, samples, finalUpstreamActive, peakUpstreamActive,
    upstreamRequests: upstream.records.slice(recordStart).filter(r => r.body.messages?.some(m => String(m.content).startsWith(marker))) };
}

export const STAGE_URL = 'http://127.0.0.1:20138';
export const STAGE_DATA_DIR = '/opt/omniroute-quality-speed-stage-data';
export const SCENARIOS = ['slow', '429', '500', 'early-eof', 'stream-error', 'abort', 'tool'];

export function assessWave(wave, { paths = ['/healthz', '/api/providers', '/api/settings'], enforceHealthBudget = true } = {}) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const allowed = { slow: ['completed'], tool: ['completed'], '429': ['http_error'], '500': ['http_error'],
    'early-eof': ['stream_truncated', 'upstream_error', 'protocol_error'], 'stream-error': ['upstream_error'], abort: ['client_abort'] };
  check(wave.requests.length === wave.concurrency, 'request denominator mismatch');
  check(wave.finalUpstreamActive === 0, 'upstream slots still occupied after release deadline');
  check(wave.upstreamRequests.length >= wave.concurrency, 'not every request reached the synthetic upstream');
  check(wave.upstreamRequests.length <= wave.concurrency * (['429', '500'].includes(wave.scenario) ? 3 : 1), 'unexpected replay/duplicate upstream requests');
  for (const request of wave.requests) {
    check(allowed[wave.scenario]?.includes(request.outcome), `request ${request.index}: unexpected outcome ${request.outcome}`);
    check(request.models?.every(m => m === 'probe-model' || m === request.requestedModel), `request ${request.index}: model identity changed`);
    if (wave.scenario === 'slow') {
      check(request.text === 'Ответ 🌿 без дублей.', `request ${request.index}: text lost or duplicated`);
      check(request.terminal && request.finishReasons?.length === 1 && request.finishReasons[0] === 'stop', `request ${request.index}: terminal mismatch`);
      check(request.firstEventMs !== null && request.firstTextMs > request.firstEventMs, `request ${request.index}: heartbeat/reasoning counted as text`);
    }
    if (['early-eof', 'stream-error', 'abort'].includes(wave.scenario)) check(request.text === 'Ответ 🌿', `request ${request.index}: partial text lost or replayed`);
    if (wave.scenario === '429') check(request.status === 429 && request.retryAfter !== null, `request ${request.index}: 429/Retry-After missing`);
    if (wave.scenario === '500') check(request.status >= 500 && request.status < 600, `request ${request.index}: upstream 500 hidden`);
    if (wave.scenario === 'tool') {
      check(request.text === '', `request ${request.index}: fabricated tool text`);
      check(request.toolCalls?.length === 1 && request.toolCalls[0].name === 'dummy' && request.toolCalls[0].arguments === '{"x":1}', `request ${request.index}: tool arguments lost/duplicated`);
      check(request.finishReasons?.length === 1 && request.finishReasons[0] === 'tool_calls', `request ${request.index}: tool terminal mismatch`);
    }
  }
  for (const record of wave.upstreamRequests) {
    const body = record.body;
    check(body.model === 'probe-model', 'upstream model identity changed');
    check(body.reasoning_effort === 'high' && body.max_tokens === 4096 && body.temperature === 0.7, 'upstream effort/limits/temperature changed');
    check(body.messages?.[0]?.role === 'system' && body.messages[0].content === 'Keep synthetic instructions and reasoning effort.', 'upstream system instructions changed');
  }
  if (wave.scenario === 'abort') check(wave.upstreamRequests.filter(r => r.disconnected).length === wave.concurrency, 'abort did not disconnect every synthetic upstream');
  const byPath = {};
  for (const path of paths) {
    // Include health that starts DURING upstream work even if it completes afterwards.
    // Excluding slow samples at completion would hide event-loop freezes.
    const overlap = wave.samples.filter(s => s.path === path && s.inFlightAtStart > 0 && s.upstreamActiveAtStart > 0);
    const values = overlap.map(s => s.ms).sort((a, b) => a - b);
    const p95Ms = values.length ? values[Math.ceil(values.length * 0.95) - 1] : null;
    byPath[path] = { samples: overlap.length, p95Ms, maxMs: values.at(-1) ?? null,
      errors: overlap.filter(s => s.status !== 200 || s.error).length };
    check(overlap.length > 0, `${path}: no simultaneous upstream overlap samples`);
    check(wave.samples.filter(s => s.path === path).every(s => s.status === 200 && !s.error), `${path}: unavailable during generation`);
    if (enforceHealthBudget && path === '/healthz' && wave.scenario === 'slow' && wave.concurrency === 4) check(p95Ms !== null && p95Ms < 500, '/healthz: p95 not below 500ms at concurrency 4');
  }
  return { failures, byPath };
}

export function assertStageIdentity({ baseUrl, unitEnvironment, unitActiveState }) {
  if (baseUrl !== STAGE_URL) throw new Error('staging URL is fixed; production is forbidden');
  const expected = { DATA_DIR: STAGE_DATA_DIR, HOST: '127.0.0.1', PORT: '20138', DASHBOARD_PORT: '20138',
    OMNIROUTE_DISABLE_BACKGROUND_SERVICES: '1', OMNIROUTE_E2E_BOOTSTRAP_MODE: 'open' };
  for (const [key, value] of Object.entries(expected)) {
    if (!unitEnvironment.split(/\s+/).includes(`${key}=${value}`)) throw new Error(`staging ${key} identity mismatch`);
  }
  if (unitActiveState !== 'active') throw new Error(`staging not ready: unit ${unitActiveState}`);
}

// Own a new node/account; never rewrite an existing provider or settings.
// Node deletion cascades only its owned account. Finally verify exact ids disappeared.
export async function withSyntheticProvider({ api, upstreamBaseUrl }, run) {
  const parsed = new URL(upstreamBaseUrl);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/v1') throw new Error('synthetic upstream must be loopback /v1');
  const prefix = `f2-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let nodeId;
  let connectionId;
  const lifecycle = { prefix, createdReadback: false, activeReadback: false, cleanupReadback: false };
  try {
    const created = await api('/api/provider-nodes', 'POST', { name: `F2 synthetic ${prefix}`, prefix, type: 'openai-compatible',
      apiType: 'chat', baseUrl: upstreamBaseUrl, chatPath: '/chat/completions', modelsPath: '/models', customHeaders: {}, iconUrl: '' });
    nodeId = created.node?.id;
    if (!nodeId) throw new Error('synthetic node creation returned no id');
    lifecycle.nodeId = nodeId;
    const nodeRead = (await api('/api/provider-nodes')).nodes?.find(n => n.id === nodeId);
    if (!nodeRead || nodeRead.baseUrl !== upstreamBaseUrl || nodeRead.prefix !== prefix || nodeRead.apiType !== 'chat') throw new Error('synthetic node exact-id readback mismatch');
    const added = await api('/api/providers', 'POST', { provider: nodeId, name: `F2 synthetic ${prefix}`, apiKey: 'f2-synthetic-not-a-real-key',
      priority: 1, globalPriority: null, defaultModel: 'probe-model', testStatus: 'unknown',
      providerSpecificData: { autoFetchModels: false } });
    connectionId = added.connection?.id;
    if (!connectionId) throw new Error('synthetic connection creation returned no id');
    lifecycle.connectionId = connectionId;
    const connectionPath = `/api/providers/${encodeURIComponent(connectionId)}`;
    const createdRead = (await api(connectionPath)).connection;
    if (createdRead?.id !== connectionId || createdRead.provider !== nodeId || createdRead.providerSpecificData?.baseUrl !== upstreamBaseUrl) throw new Error('synthetic provider exact-id readback mismatch');
    lifecycle.createdReadback = true;
    await api(connectionPath, 'PUT', { isActive: true, testStatus: 'active', priority: 1, globalPriority: null,
      defaultModel: 'probe-model', maxConcurrent: 16, healthCheckInterval: 0, rateLimitedUntil: null, lastError: null,
      lastErrorType: null, lastErrorSource: null, errorCode: null, providerSpecificData: { autoFetchModels: false } });
    const activeRead = (await api(connectionPath)).connection;
    if (activeRead?.id !== connectionId || activeRead.isActive !== true || activeRead.maxConcurrent !== 16 || activeRead.defaultModel !== 'probe-model') throw new Error('synthetic provider activation readback mismatch');
    lifecycle.activeReadback = true;
    return await run({ model: `${prefix}/probe-model`, connectionId, nodeId, lifecycle });
  } finally {
    if (nodeId) {
      await api(`/api/provider-nodes/${encodeURIComponent(nodeId)}`, 'DELETE');
      const nodes = await api('/api/provider-nodes');
      const providers = await api('/api/providers');
      if (!Array.isArray(nodes.nodes) || !Array.isArray(providers.connections) || nodes.nodes.some(n => n.id === nodeId) ||
        providers.connections.some(c => c.id === connectionId || c.provider === nodeId)) throw new Error(`synthetic cleanup readback failed: ${nodeId}`);
      lifecycle.cleanupReadback = true;
    }
  }
}

const reportBase = mode => ({ schemaVersion: 1, mode, startedAt: new Date().toISOString(), status: 'running', waves: [],
  methodology: { simultaneous: 'samples started while both client requests and synthetic upstream were active; slow completions are retained',
    percentile: 'nearest-rank p95, sample count reported', usage: 'synthetic provider fixture only', tps: null,
    limits: ['not a live-provider availability or quality benchmark', 'not upstream inference throughput',
      'internal Node worker/pending queues are not directly instrumented; active upstream sockets and replay counts only'] } });
const finishReport = report => {
  report.completedAt = new Date().toISOString();
  report.requestCount = report.waves.reduce((n, w) => n + w.requests.length, 0);
  report.failureCount = report.waves.reduce((n, w) => n + (w.assessment?.failures.length ?? 0), 0);
  report.waveCount = report.waves.length;
  if (report.status === 'running') report.status = report.failureCount ? 'failed' : 'passed';
  return report;
};

function readStageIdentity() {
  const text = execFileSync('systemctl', ['show', 'omniroute-quality-stage', '--property=Environment,ActiveState,MainPID'], { encoding: 'utf8', timeout: 8000 });
  const values = Object.fromEntries(text.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  return { baseUrl: STAGE_URL, unitEnvironment: values.Environment ?? '', unitActiveState: values.ActiveState, mainPID: values.MainPID };
}

export async function runStageProbe({ concurrencies = [1, 4, 8], scenarios = SCENARIOS, readIdentity = readStageIdentity } = {}) {
  const report = reportBase('staging-gateway');
  report.baseUrl = STAGE_URL;
  report.dataDir = STAGE_DATA_DIR;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${STAGE_URL}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', 'x-skip-model-sync': 'true' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`staging management ${method} ${path}: HTTP ${response.status}`);
    return await response.json();
  };
  try {
    const identity = await readIdentity();
    report.unit = { activeState: identity.unitActiveState, mainPID: identity.mainPID };
    assertStageIdentity(identity);
    const ready = await fetch(`${STAGE_URL}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (ready.status !== 200 || (await ready.text()).trim() !== 'ok') throw new Error(`staging /healthz not ready: ${ready.status}`);
    const [settings, baseline] = await Promise.all([api('/api/settings'), api('/api/providers')]);
    if (settings.cloudEnabled === true || settings.enableCloudSync === true) throw new Error('staging cloud sync must be disabled before synthetic provider mutations');
    if (!Array.isArray(baseline.connections)) throw new Error('invalid staging providers identity');
    if (baseline.connections.some(c => !String(c.name ?? '').startsWith('F2 synthetic '))) throw new Error('staging contains other providers; refuse fixtures until isolated/serial run');
    report.baselineProviderIds = baseline.connections.map(c => c.id);
    for (const concurrency of concurrencies) {
      for (const scenario of scenarios) {
        if (!SCENARIOS.includes(scenario)) throw new Error('unknown synthetic scenario');
        const upstream = await createSyntheticUpstream();
        try {
          await withSyntheticProvider({ api, upstreamBaseUrl: upstream.baseUrl }, async ({ model, lifecycle }) => {
            const wave = await runWave({ baseUrl: STAGE_URL, model, concurrency, scenario, upstream });
            wave.lifecycle = lifecycle;
            wave.assessment = assessWave(wave);
            report.waves.push(wave);
          });
        } finally { await upstream.stop(); }
      }
    }
  } catch (error) {
    report.status = 'blocked';
    report.blocker = error.message;
  }
  return finishReport(report);
}

export async function runSelfProbe({ concurrencies = [1, 4, 8], scenarios = SCENARIOS } = {}) {
  const report = reportBase('isolated-transport-harness');
  const upstream = await createSyntheticUpstream();
  report.baseUrl = upstream.origin;
  try {
    for (const concurrency of concurrencies) {
      for (const scenario of scenarios) {
        if (!SCENARIOS.includes(scenario)) throw new Error('unknown synthetic scenario');
        const wave = await runWave({ baseUrl: upstream.origin, model: 'probe-model', concurrency, scenario, upstream,
          samplePaths: ['/healthz'], sampleIntervalMs: 20 });
        wave.assessment = assessWave(wave, { paths: ['/healthz'], enforceHealthBudget: false });
        report.waves.push(wave);
      }
    }
  } catch (error) { report.status = 'blocked'; report.blocker = error.message; }
  finally { await upstream.stop(); }
  return finishReport(report);
}

export default async function guardPlaywrightStage(config) {
  if (!config?.projects?.length || config.projects.some(project => project.use?.baseURL !== STAGE_URL)) {
    throw new Error('Playwright staging URL is fixed; production login/onboarding is forbidden');
  }
  assertStageIdentity(readStageIdentity());
  const ready = await fetch(`${STAGE_URL}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (ready.status !== 200 || (await ready.text()).trim() !== 'ok') throw new Error(`staging /healthz not ready: ${ready.status}`);
  const settings = await fetch(`${STAGE_URL}/api/settings`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!settings.ok) throw new Error(`staging management not open: ${settings.status}; no automatic login`);
  const state = await settings.json();
  if (state.requireLogin === true) throw new Error('staging requires login; this runner must not set passwords or onboard');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const self = args.includes('--self-test');
  let reportPath = self ? 'docs/ops/quality-speed-load-harness.json' : 'docs/ops/quality-speed-load.json';
  let concurrencies = [1, 4, 8];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--self-test') continue;
    if (args[i] === '--report' && args[i + 1]) { reportPath = args[++i]; continue; }
    if (args[i] === '--concurrency' && args[i + 1]) { concurrencies = args[++i].split(',').map(Number); continue; }
    throw new Error(`unknown argument: ${args[i]}; allowed: --self-test --report PATH --concurrency 1,4,8`);
  }
  if (!concurrencies.length || concurrencies.some(n => ![1, 4, 8].includes(n))) throw new Error('allowed concurrency: 1, 4, 8');
  const report = await (self ? runSelfProbe({ concurrencies }) : runStageProbe({ concurrencies }));
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: resolve(reportPath), mode: report.mode, status: report.status,
    waves: report.waveCount, requests: report.requestCount, assertionFailures: report.failureCount, blocker: report.blocker,
    results: report.waves.map(w => ({ concurrency: w.concurrency, scenario: w.scenario, upstreamPeak: w.peakUpstreamActive,
      finalActive: w.finalUpstreamActive, outcomes: w.requests.map(r => r.outcome), health: w.assessment.byPath['/healthz'], failures: w.assessment.failures })) }, null, 2));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
