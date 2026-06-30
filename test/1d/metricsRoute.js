'use strict';

// [Consultor · 1D] Endpoint admin /admin/chat/metrics. Gate duplo (AI_CHAT_METRICS_ENABLED + ADMIN_TOKEN),
// match timing-safe, leitura read-only do snapshot. Sem DB.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { makeMetricsHandler, tokensMatch } = require('../../src/routes/chatMetricsRoutes');
const { createMetrics } = require('../../src/services/conversation/metrics');

function req(headers = {}) { return { headers }; }

module.exports = () => {
  test('METRICS · feature desligada (sem AI_CHAT_METRICS_ENABLED) → 404 (não revela rota)', async () => {
    const res = H.mockRes();
    makeMetricsHandler({ metrics: createMetrics(), env: { ADMIN_TOKEN: 'secret' } })(req({ authorization: 'Bearer secret' }), res);
    assert.strictEqual(res.statusCode, 404);
  });

  test('METRICS · ligada mas sem ADMIN_TOKEN configurado → 404 (não habilita sem segredo)', async () => {
    const res = H.mockRes();
    makeMetricsHandler({ metrics: createMetrics(), env: { AI_CHAT_METRICS_ENABLED: 'true' } })(req({ authorization: 'Bearer x' }), res);
    assert.strictEqual(res.statusCode, 404);
  });

  test('METRICS · token ausente → 401', async () => {
    const res = H.mockRes();
    makeMetricsHandler({ metrics: createMetrics(), env: { AI_CHAT_METRICS_ENABLED: 'true', ADMIN_TOKEN: 'secret' } })(req({}), res);
    assert.strictEqual(res.statusCode, 401);
  });

  test('METRICS · token errado → 401', async () => {
    const res = H.mockRes();
    makeMetricsHandler({ metrics: createMetrics(), env: { AI_CHAT_METRICS_ENABLED: 'true', ADMIN_TOKEN: 'secret' } })(req({ authorization: 'Bearer wrong' }), res);
    assert.strictEqual(res.statusCode, 401);
  });

  test('METRICS · token certo (Bearer) → 200 com snapshot e names', async () => {
    const m = createMetrics(); m.inc('replay_total'); m.inc('refund_total'); m.inc('refund_total');
    const res = H.mockRes();
    makeMetricsHandler({ metrics: m, env: { AI_CHAT_METRICS_ENABLED: 'true', ADMIN_TOKEN: 'secret' } })(req({ authorization: 'Bearer secret' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonBody.metrics.replay_total, 1);
    assert.strictEqual(res.jsonBody.metrics.refund_total, 2);
    assert.ok(Array.isArray(res.jsonBody.names) && res.jsonBody.names.includes('drift_nonzero'));
  });

  test('METRICS · token certo via x-admin-token → 200', async () => {
    const res = H.mockRes();
    makeMetricsHandler({ metrics: createMetrics(), env: { AI_CHAT_METRICS_ENABLED: 'true', ADMIN_TOKEN: 'secret' } })(req({ 'x-admin-token': 'secret' }), res);
    assert.strictEqual(res.statusCode, 200);
  });

  test('tokensMatch · timing-safe: igual=true; diferente/comprimentos distintos=false; vazios=false', () => {
    assert.strictEqual(tokensMatch('abc', 'abc'), true);
    assert.strictEqual(tokensMatch('abc', 'abcd'), false); // comprimentos diferentes não lançam (digest fixo)
    assert.strictEqual(tokensMatch('abc', 'abd'), false);
    assert.strictEqual(tokensMatch('', 'x'), false);
    assert.strictEqual(tokensMatch(null, 'x'), false);
    assert.strictEqual(tokensMatch('x', null), false);
  });
};
