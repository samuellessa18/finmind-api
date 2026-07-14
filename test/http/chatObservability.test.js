'use strict';

// [Consultor · F4.8] Testes de OBSERVABILIDADE — módulo (métricas/tracer/decoradores) + middleware HTTP real.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createChatObservability, classifyStatus } = require('../../src/services/conversation/chatObservability');
const { chatObservabilityMiddleware } = require('../../src/middleware/chatObservabilityMiddleware');

process.env.AI_CHAT_OBS_ENABLED = 'true'; // liga o log estruturado para os testes

// ── Unit: métricas ──
test('OBS/metrics · snapshot inicial zerado', () => {
  const s = createChatObservability({ sink: () => {} }).snapshot();
  assert.strictEqual(s.turns_total, 0);
  assert.deepStrictEqual(s.by_status, { s401: 0, s403: 0, s429: 0, s500: 0, s503: 0, ok: 0 });
  assert.strictEqual(s.turns_per_min, 0);
});

test('OBS/metrics · recordHttp classifica status e conta turnos/create/consent', () => {
  const obs = createChatObservability({ sink: () => {} });
  obs.recordHttp({ method: 'POST', path: '/api/v1/conversations/turn', status: 503 });
  obs.recordHttp({ method: 'POST', path: '/api/v1/conversations/turn', status: 403 });
  obs.recordHttp({ method: 'POST', path: '/api/v1/conversations', status: 201 });
  obs.recordHttp({ method: 'POST', path: '/api/v1/conversations/consent', status: 200 });
  obs.recordHttp({ method: 'POST', path: '/api/v1/conversations/x', status: 401 });
  const s = obs.snapshot();
  assert.strictEqual(s.turns_total, 2);
  assert.strictEqual(s.create_total, 1);
  assert.strictEqual(s.consent_total, 1);
  assert.strictEqual(s.by_status.s503, 1);
  assert.strictEqual(s.by_status.s403, 1);
  assert.strictEqual(s.by_status.ok, 2);
  assert.strictEqual(s.by_status.s401, 1);
  assert.strictEqual(s.turns_per_min, 2);
});

test('OBS/util · classifyStatus mapeia 401/403/429/503/500/ok', () => {
  assert.strictEqual(classifyStatus(401), 's401');
  assert.strictEqual(classifyStatus(403), 's403');
  assert.strictEqual(classifyStatus(429), 's429');
  assert.strictEqual(classifyStatus(503), 's503');
  assert.strictEqual(classifyStatus(500), 's500');
  assert.strictEqual(classifyStatus(200), 'ok');
});

// ── Unit: tracer ──
test('OBS/tracer · span/mark/end → durationMs, spans e log estruturado', () => {
  const logs = [];
  let t = 0;
  const obs = createChatObservability({ sink: (l) => logs.push(JSON.parse(l)), clock: () => (t += 5) });
  const tr = obs.startTrace({ requestId: 'r1', conversationId: 'c1' });
  tr.span('consent').end();
  tr.setField('userId', 'u1');
  const rec = tr.end({ status: 503, error: 'chat_unavailable', result: 'error' });
  assert.strictEqual(rec.requestId, 'r1');
  assert.strictEqual(rec.conversationId, 'c1');
  assert.strictEqual(rec.userId, 'u1');
  assert.strictEqual(rec.status, 503);
  assert.strictEqual(typeof rec.durationMs, 'number');
  assert.ok('consent' in rec.spans);
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].event, 'turn');
  assert.strictEqual(logs[0].requestId, 'r1');
});

// ── Unit: decoradores (prontos p/ F5) ──
test('OBS/wrapProvider · sucesso ok; erro incrementa provider_error_total e repropaga', async () => {
  const obs = createChatObservability({ sink: () => {} });
  const tr = obs.startTrace({});
  const ok = obs.wrapProvider({ run: async () => ({ stopReason: 'end_turn', text: 'ok' }) }, tr);
  assert.strictEqual((await ok.run({})).text, 'ok');
  const fail = obs.wrapProvider({ run: async () => { throw new Error('boom'); } }, tr);
  await assert.rejects(() => fail.run({}), /boom/);
  assert.strictEqual(obs.snapshot().provider_error_total, 1);
});

test('OBS/wrapProvider · provider null (dormente) → null', () => {
  const obs = createChatObservability({ sink: () => {} });
  assert.strictEqual(obs.wrapProvider(null, obs.startTrace({})), null);
});

test('OBS/wrapToolExecutor · devolve o resultado (span temporizado)', async () => {
  const obs = createChatObservability({ sink: () => {} });
  const exec = obs.wrapToolExecutor(async (tu) => `result:${tu.name}`, obs.startTrace({}));
  assert.strictEqual(await exec({ name: 'get_financial_summary' }), 'result:get_financial_summary');
});

// ── Integração: middleware HTTP real ──
let server, baseUrl, obs, logs;
before(async () => {
  logs = [];
  obs = createChatObservability({ sink: (l) => logs.push(JSON.parse(l)) });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/conversations', chatObservabilityMiddleware(obs));
  app.post('/api/v1/conversations', (req, res) => res.status(201).json({ conversationId: 'c1', createdAt: 'now', title: null }));
  app.post('/api/v1/conversations/turn', (req, res) => {
    if (req.header('x-scenario') === 'authed') { req.user = { id: 'u1' }; return res.status(503).json({ error: 'chat_unavailable', turnId: 't1' }); }
    return res.status(403).json({ error: 'consent_required' });
  });
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((res) => (server ? server.close(res) : res())); });

const post = (path, { headers, body } = {}) =>
  fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body || {}) });

test('OBS/http · turn 403 → conta s403+turn; log tem error/conversationId/requestId/durationMs', async () => {
  const b = obs.snapshot();
  const r = await post('/api/v1/conversations/turn', { body: { conversationId: 'cX', idempotencyKey: 'k'.repeat(20) } });
  assert.strictEqual(r.status, 403);
  const s = obs.snapshot();
  assert.strictEqual(s.by_status.s403, b.by_status.s403 + 1);
  assert.strictEqual(s.turns_total, b.turns_total + 1);
  const last = logs[logs.length - 1];
  assert.strictEqual(last.status, 403);
  assert.strictEqual(last.error, 'consent_required');
  assert.strictEqual(last.conversationId, 'cX');
  assert.strictEqual(last.result, 'error');
  assert.ok(last.requestId);
  assert.strictEqual(typeof last.durationMs, 'number');
});

test('OBS/http · turn 503 chat_unavailable + userId capturado no finish', async () => {
  const r = await post('/api/v1/conversations/turn', { headers: { 'x-scenario': 'authed' }, body: { conversationId: 'cY' } });
  assert.strictEqual(r.status, 503);
  const last = logs[logs.length - 1];
  assert.strictEqual(last.error, 'chat_unavailable');
  assert.strictEqual(last.userId, 'u1');
  assert.strictEqual(last.turnId, 't1');
});

test('OBS/http · create 201 → conta create_total e resultado ok', async () => {
  const b = obs.snapshot();
  const r = await post('/api/v1/conversations');
  assert.strictEqual(r.status, 201);
  assert.strictEqual(obs.snapshot().create_total, b.create_total + 1);
  assert.strictEqual(logs[logs.length - 1].result, 'ok');
});
