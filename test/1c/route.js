'use strict';

// [Consultor · 1C] Rota — composição dos gates via makeTurnHandler (mock req/res; auth fora, req.user
// já populado). Zod 400 / posse 404 / rate-limit 429 / consent 403 / dormente 503 / happy SSE.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { makeTurnHandler } = require('../../src/routes/conversationRoutes');
const { createRateLimiter } = require('../../src/services/conversation/rateLimiter');

const DAY = '2026-06-26';
const VALID_KEY = 'kroute000000000001';

function mockRes() {
  const res = { statusCode: null, jsonBody: undefined, headers: {}, frames: [], headersSent: false, ended: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.jsonBody = o; res.headersSent = true; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.writeHead = (c, h) => { res.statusCode = c; Object.assign(res.headers, h || {}); res.headersSent = true; return res; };
  res.write = (s) => { res.frames.push(s); return true; };
  res.end = () => { res.ended = true; return res; };
  return res;
}
const permissiveRL = () => createRateLimiter({ windowMs: 60000, maxInWindow: 1000 });
const stubProvider = () => H.makeProvider([{ stopReason: 'end_turn', text: 'resposta', usage: { input_tokens: 2, output_tokens: 2 } }]);

async function setup(ctx, { consent = true } = {}) {
  const u = await H.seedUser(ctx.prisma, { plan: 'free' });
  const conv = await H.seedConversation(ctx.prisma, u.id);
  if (consent) await H.seedConsent(ctx.prisma, u.id, { scope: 'ai_chat' });
  return { u, conv };
}

module.exports = (ctx) => {
  test('ROUTE · Zod inválido (idempotencyKey curta) → 400', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const deps = { prisma, rateLimiter: permissiveRL(), metrics: H.metrics(), buildProvider: stubProvider };
    const res = mockRes();
    await makeTurnHandler(deps)({ user: u, body: { conversationId: conv.id, userMessage: 'oi', idempotencyKey: 'curta' } }, res, () => {});
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.jsonBody.error, 'invalid_request');
  });

  test('ROUTE/D1C-4 · posse: conversa alheia/inexistente → 404 (sem consumir cota)', async () => {
    const { prisma } = ctx; const { u } = await setup(ctx);
    const deps = { prisma, rateLimiter: permissiveRL(), metrics: H.metrics(), buildProvider: stubProvider };
    const res = mockRes();
    await makeTurnHandler(deps)({ user: u, body: { conversationId: 'nao-existe', userMessage: 'oi', idempotencyKey: VALID_KEY } }, res, () => {});
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
  });

  test('ROUTE/D1C-7 · sem consent ai_chat → 403 consent_required, sem consumir cota', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx, { consent: false });
    const deps = { prisma, rateLimiter: permissiveRL(), metrics: H.metrics(), buildProvider: stubProvider };
    const res = mockRes();
    await makeTurnHandler(deps)({ user: u, body: { conversationId: conv.id, userMessage: 'oi', idempotencyKey: VALID_KEY } }, res, () => {});
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.jsonBody.error, 'consent_required');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
  });

  test('ROUTE · rate-limit estourado → 429 rate_limited + Retry-After, sem consumir cota', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const deps = { prisma, rateLimiter: { check: () => ({ allowed: false, retryAfterMs: 1000 }) }, metrics: H.metrics(), buildProvider: stubProvider };
    const res = mockRes();
    await makeTurnHandler(deps)({ user: u, body: { conversationId: conv.id, userMessage: 'oi', idempotencyKey: VALID_KEY } }, res, () => {});
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.jsonBody.error, 'rate_limited');
    assert.strictEqual(res.headers['Retry-After'], '1');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
  });

  test('ROUTE · provider dormente (gated) → 503 chat_unavailable, sem consumir cota', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const deps = { prisma, rateLimiter: permissiveRL(), metrics: H.metrics(), buildProvider: () => null };
    const res = mockRes();
    await makeTurnHandler(deps)({ user: u, body: { conversationId: conv.id, userMessage: 'oi', idempotencyKey: VALID_KEY } }, res, () => {});
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.jsonBody.error, 'chat_unavailable');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, 'feature dormente NÃO consome cota');
  });

  test('ROUTE · happy path → SSE 200 com frame done; turno BILLED', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const deps = { prisma, rateLimiter: permissiveRL(), metrics: H.metrics(), buildProvider: stubProvider, buildToolExecutor: () => null };
    const res = mockRes();
    await makeTurnHandler(deps)({ user: u, body: { conversationId: conv.id, userMessage: 'oi', idempotencyKey: VALID_KEY } }, res, () => {});
    assert.strictEqual(res.ended, true);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
    const wire = res.frames.join('');
    assert.ok(/event: done/.test(wire), 'emitiu frame done');
    assert.ok(/resposta/.test(wire), 'done carrega o conteúdo persistido');
    const turn = await prisma.chatTurn.findFirst({ where: { userId: u.id } });
    assert.strictEqual(turn.state, 'BILLED');
    // a rota usa now() do Postgres (sem nowIso) → dayKey é a data real; assertar sobre o dayKey persistido
    assert.strictEqual(await H.usageCount(prisma, u.id, turn.dayKey), 1);
    await H.assertDriftZero(assert, prisma, u.id, turn.dayKey, null);
  });
};
