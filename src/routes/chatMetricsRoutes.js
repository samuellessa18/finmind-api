'use strict';

// [Consultor · 1D] Endpoint admin de observabilidade (D1D-8). GET /admin/chat/metrics — SOMENTE leitura
// dos contadores em memória (metrics.snapshot()); NUNCA toca o turno nem o DB no caminho padrão.
//
// Gate duplo (D1D-10 — desligado por padrão, sem segredo embutido):
//   1) AI_CHAT_METRICS_ENABLED === 'true'  (senão 404: não revela que a rota existe)
//   2) ADMIN_TOKEN definido + match timing-safe do header  (senão 404/401)
// Comparação por digest SHA-256 de comprimento fixo (timingSafeEqual exige buffers de igual tamanho;
// comparar os tokens crus vazaria o comprimento). Bearer ou x-admin-token.

const crypto = require('crypto');
const { defaultMetrics } = require('../services/conversation/metrics');

function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest(); }

function tokensMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = sha256(provided);
  const b = sha256(expected);
  // a e b têm 32 bytes sempre → timingSafeEqual nunca lança por tamanho.
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const x = req.headers && (req.headers['x-admin-token'] || req.headers['X-Admin-Token']);
  return x ? String(x).trim() : null;
}

// Handler injetável (env/metrics) p/ teste com mock req/res.
function makeMetricsHandler({ metrics = defaultMetrics, env = process.env } = {}) {
  return function metricsHandler(req, res) {
    if (env.AI_CHAT_METRICS_ENABLED !== 'true') return res.status(404).json({ error: 'not_found' });
    const expected = env.ADMIN_TOKEN;
    if (!expected) return res.status(404).json({ error: 'not_found' }); // sem segredo configurado → não habilita
    if (!tokensMatch(extractToken(req), expected)) return res.status(401).json({ error: 'unauthorized' });
    return res.status(200).json({ metrics: metrics.snapshot(), names: metrics.names });
  };
}

function createChatMetricsRouter(deps = {}) {
  const express = require('express');
  const router = express.Router();
  router.get('/admin/chat/metrics', makeMetricsHandler(deps));
  return router;
}

module.exports = { createChatMetricsRouter, makeMetricsHandler, tokensMatch, extractToken };
