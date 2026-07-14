'use strict';

// [Consultor · F4.5] Validação de INFRAESTRUTURA HTTP REAL entre a cadeia do frontend e o backend,
// SEM IA. Sobe um Express REAL + Postgres efêmero + auth REAL (JWT/Bearer/Session), com o provider
// DORMENTE (buildProvider→null → 503). Exerce os endpoints por HTTP de verdade (fetch), validando:
// JWT/Bearer/401 · criar conversa (201) · turn sem consent (403) · consent (200) · turn dormente (503)
// · estabilidade sob mesma idempotencyKey (sem cota) · erros (400 Zod / 404 posse).
//
// Segurança: o singleton `prisma/client` (usado pelo authenticateToken) liga no DB EFÊMERO porque
// DATABASE_URL é setado para a URL do cluster embedded ANTES do primeiro require de conversationRoutes.
// Jamais toca banco de produção. Roda standalone: `node --test test/http/httpInfra.test.js`.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const H = require('../e2/harness');

const JWT_SECRET = 'f45-http-infra-secret-0123456789-0123456789-0123456789';
let ctx, server, prisma, baseUrl;

before(async () => {
  ctx = await H.boot(); // embedded PG + migrate deploy
  prisma = ctx.prisma;
  // liga o singleton de auth no MESMO cluster efêmero (antes do require abaixo):
  process.env.DATABASE_URL = ctx.url;
  process.env.JWT_SECRET = JWT_SECRET;

  const { createConversationRouter } = require('../../src/routes/conversationRoutes');
  const { createRateLimiter } = require('../../src/services/conversation/rateLimiter');
  const { createMetrics } = require('../../src/services/conversation/metrics');

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createConversationRouter({
      prisma,
      rateLimiter: createRateLimiter({ windowMs: 60000, maxInWindow: 1000 }),
      metrics: createMetrics(),
      buildProvider: () => null, // PROVIDER DORMENTE → 503 chat_unavailable (SEM Claude/Anthropic)
    }),
  );
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
}, { timeout: 180000 });

after(async () => {
  await new Promise((res) => (server ? server.close(res) : res()));
  if (ctx && ctx.stop) await ctx.stop();
});

// Cria User + Session válidos e assina o JWT (mesmo formato do authRoutes: { id, jti }).
async function authed() {
  const user = await H.seedUser(prisma, { plan: 'free' });
  const jti = crypto.randomUUID();
  await prisma.session.create({ data: { id: jti, userId: user.id, expiresAt: new Date(Date.now() + 3600e3) } });
  const token = jwt.sign({ id: user.id, jti }, JWT_SECRET, { expiresIn: '1h' });
  return { user, token };
}
const key = () => crypto.randomUUID(); // 36 chars → casa ^[A-Za-z0-9_-]{16,64}$
function call(method, path, { token, body } = {}) {
  return fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('HTTP/AUTH · sem Bearer → 401', async () => {
  assert.strictEqual((await call('POST', '/conversations')).status, 401);
});

test('HTTP/AUTH · Bearer inválido → 401', async () => {
  assert.strictEqual((await call('POST', '/conversations', { token: 'token-lixo' })).status, 401);
});

test('HTTP/AUTH · JWT válido sem Session persistida → 401 (Sessão inválida)', async () => {
  const user = await H.seedUser(prisma, { plan: 'free' });
  const orphan = jwt.sign({ id: user.id, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '1h' }); // sem Session
  assert.strictEqual((await call('POST', '/conversations', { token: orphan })).status, 401);
});

test('HTTP/CREATE · POST /conversations com Bearer → 201 { conversationId, title:null }', async () => {
  const { token } = await authed();
  const r = await call('POST', '/conversations', { token });
  assert.strictEqual(r.status, 201);
  const j = await r.json();
  assert.ok(j.conversationId);
  assert.strictEqual(j.title, null);
});

test('HTTP/TURN · sem consent → 403 consent_required', async () => {
  const { token } = await authed();
  const c = await (await call('POST', '/conversations', { token })).json();
  const r = await call('POST', '/conversations/turn', {
    token,
    body: { conversationId: c.conversationId, userMessage: 'oi', idempotencyKey: key() },
  });
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await r.json()).error, 'consent_required');
});

test('HTTP/CONSENT+TURN · grant 200 → turn com consent, provider DORMENTE → 503 chat_unavailable', async () => {
  const { token } = await authed();
  const c = await (await call('POST', '/conversations', { token })).json();
  assert.strictEqual((await call('POST', '/conversations/consent', { token })).status, 200);
  const r = await call('POST', '/conversations/turn', {
    token,
    body: { conversationId: c.conversationId, userMessage: 'oi', idempotencyKey: key() },
  });
  assert.strictEqual(r.status, 503);
  assert.strictEqual((await r.json()).error, 'chat_unavailable');
});

test('HTTP/ESTABILIDADE · mesma idempotencyKey 2× (provider dormente) → 503/503, cota=0 (sem duplicar efeito)', async () => {
  const { token, user } = await authed();
  const c = await (await call('POST', '/conversations', { token })).json();
  await call('POST', '/conversations/consent', { token });
  const body = { conversationId: c.conversationId, userMessage: 'oi', idempotencyKey: key() };
  const r1 = await call('POST', '/conversations/turn', { token, body });
  const r2 = await call('POST', '/conversations/turn', { token, body });
  assert.strictEqual(r1.status, 503);
  assert.strictEqual(r2.status, 503);
  assert.strictEqual(await prisma.chatUsage.count({ where: { userId: user.id } }), 0, 'dormente não consome cota');
});

test('HTTP/ERROS · Zod inválido (key curta) → 400; conversa alheia/inexistente → 404', async () => {
  const { token } = await authed();
  const c = await (await call('POST', '/conversations', { token })).json();
  const bad = await call('POST', '/conversations/turn', {
    token,
    body: { conversationId: c.conversationId, userMessage: 'oi', idempotencyKey: 'curta' },
  });
  assert.strictEqual(bad.status, 400);
  const notFound = await call('POST', '/conversations/turn', {
    token,
    body: { conversationId: 'nao-existe', userMessage: 'oi', idempotencyKey: key() },
  });
  assert.strictEqual(notFound.status, 404);
});
