'use strict';

// [Consultor · G1] Rota de consent ai_chat (grant/revoke) — mock req/res, auth fora (req.user populado).
// Writer vive em consentService; consentGate permanece read-only. Escopo por req.user.id, nunca body.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const {
  makeConsentGrantHandler, makeConsentRevokeHandler, makeTurnHandler,
} = require('../../src/routes/conversationRoutes');
const { hasChatConsent } = require('../../src/services/conversation/consentGate');
const { createRateLimiter } = require('../../src/services/conversation/rateLimiter');

const VALID_KEY = 'kconsent0000000001'; // 18 chars, casa ^[A-Za-z0-9_-]{16,64}$

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
const activeConsents = (prisma, userId) =>
  prisma.userConsent.count({ where: { userId, scope: 'ai_chat', revokedAt: null } });
const grant = (prisma, user, body = {}) => makeConsentGrantHandler({ prisma })({ user, body }, mockRes(), () => {});
const revoke = (prisma, user, body = {}) => makeConsentRevokeHandler({ prisma })({ user, body }, mockRes(), () => {});

module.exports = (ctx) => {
  test('CONSENT-GRANT · POST → 200 granted; hasChatConsent true; 1 linha ativa', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    const res = mockRes();
    await makeConsentGrantHandler({ prisma })({ user: u, body: {} }, res, () => {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonBody.status, 'granted');
    assert.strictEqual(res.jsonBody.scope, 'ai_chat');
    assert.strictEqual(await hasChatConsent(prisma, u.id), true);
    assert.strictEqual(await activeConsents(prisma, u.id), 1);
  });

  test('CONSENT-REVOKE · DELETE → 200 revoked; hasChatConsent false; nenhuma ativa', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    await grant(prisma, u);
    const res = mockRes();
    await makeConsentRevokeHandler({ prisma })({ user: u, body: {} }, res, () => {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonBody.status, 'revoked');
    assert.strictEqual(await hasChatConsent(prisma, u.id), false);
    assert.strictEqual(await activeConsents(prisma, u.id), 0);
  });

  test('CONSENT-REVOKE-IDEMPOTENTE · revoke sem consent ativo → 200 (no-op)', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    const res = mockRes();
    await makeConsentRevokeHandler({ prisma })({ user: u, body: {} }, res, () => {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(await hasChatConsent(prisma, u.id), false);
  });

  test('CONSENT-IDEMPOTENTE · grant→revoke→grant → gate reaberto, >=1 ativa', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    await grant(prisma, u);
    await revoke(prisma, u);
    await grant(prisma, u);
    assert.strictEqual(await hasChatConsent(prisma, u.id), true);
    assert.ok((await activeConsents(prisma, u.id)) >= 1);
  });

  test('CONSENT-GRANT-DUPLO · grant 2× → find-guard mantém exatamente 1 ativa', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    await grant(prisma, u);
    await grant(prisma, u);
    assert.strictEqual(await activeConsents(prisma, u.id), 1);
  });

  test('CONSENT-TENANT-SCOPE · grant de A não afeta B; body.userId forjado é ignorado', async () => {
    const { prisma } = ctx;
    const uA = await H.seedUser(prisma, { plan: 'free' });
    const uB = await H.seedUser(prisma, { plan: 'free' });
    await grant(prisma, uA, { userId: uB.id }); // body tenta forjar B; handler usa req.user.id (A)
    assert.strictEqual(await hasChatConsent(prisma, uA.id), true);
    assert.strictEqual(await hasChatConsent(prisma, uB.id), false, 'B não recebe consent do body forjado');
  });

  test('CONSENT-REVOKE-FECHA-DUPLICATAS · 2 linhas ativas + revoke → gate fecha por completo', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    await H.seedConsent(prisma, u.id, { scope: 'ai_chat' }); // duas ativas (concorrência sem @@unique)
    await H.seedConsent(prisma, u.id, { scope: 'ai_chat' });
    assert.strictEqual(await activeConsents(prisma, u.id), 2);
    await revoke(prisma, u);
    assert.strictEqual(await hasChatConsent(prisma, u.id), false);
    assert.strictEqual(await activeConsents(prisma, u.id), 0, 'updateMany fecha TODAS as ativas');
  });

  test('CONSENT-ABRE-GATE · após grant, turn sai de 403 e vai a 503 (provider off), sem cota', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    const conv = await H.seedConversation(prisma, u.id);
    const turnDeps = {
      prisma, rateLimiter: createRateLimiter({ windowMs: 60000, maxInWindow: 1000 }),
      metrics: H.metrics(), buildProvider: () => null, // provider DORMENTE
    };
    const body = { conversationId: conv.id, userMessage: 'oi', idempotencyKey: VALID_KEY };
    const r1 = mockRes();
    await makeTurnHandler(turnDeps)({ user: u, body }, r1, () => {});
    assert.strictEqual(r1.statusCode, 403, 'sem consent → 403');
    await grant(prisma, u);
    const r2 = mockRes();
    await makeTurnHandler(turnDeps)({ user: u, body }, r2, () => {});
    assert.strictEqual(r2.statusCode, 503, 'com consent → passa o gate, para no provider dormente');
    assert.strictEqual(r2.jsonBody.error, 'chat_unavailable');
    assert.strictEqual(await prisma.chatUsage.count({ where: { userId: u.id } }), 0, 'gate/503 não consome cota');
  });

  test('CONSENT-READ-ONLY-GATE · consentGate não escreve (grep de contrato) — writer só em consentService', async () => {
    // Sanidade de contrato: hasChatConsent é função pura de leitura; grant/revoke vêm de consentService.
    const gate = require('../../src/services/conversation/consentGate');
    assert.strictEqual(typeof gate.hasChatConsent, 'function');
    assert.strictEqual(gate.grantChatConsent, undefined, 'consentGate NÃO expõe writer');
    assert.strictEqual(gate.revokeChatConsent, undefined, 'consentGate NÃO expõe writer');
  });
};
