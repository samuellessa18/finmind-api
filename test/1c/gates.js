'use strict';

// [Consultor · 1C] C6 (consent LGPD) + C7 (rate-limit) + posse + derivação de plano.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { hasChatConsent } = require('../../src/services/conversation/consentGate');
const { findOwnedConversation } = require('../../src/services/conversation/ownership');
const { createRateLimiter } = require('../../src/services/conversation/rateLimiter');
const { derivePlan } = require('../../src/routes/conversationRoutes');

module.exports = (ctx) => {
  test('C6/R1C-12 · consent EXISTS(ai_chat AND revokedAt IS NULL), ordem-independente', async () => {
    const { prisma } = ctx;
    // nenhuma linha → false
    const u1 = await H.seedUser(prisma, {});
    assert.strictEqual(await hasChatConsent(prisma, u1.id), false);
    // 1 ai_chat revogada → false
    const u2 = await H.seedUser(prisma, {});
    await H.seedConsent(prisma, u2.id, { scope: 'ai_chat', revoked: true });
    assert.strictEqual(await hasChatConsent(prisma, u2.id), false);
    // revogada + ativa (nesta ordem) → true
    const u3 = await H.seedUser(prisma, {});
    await H.seedConsent(prisma, u3.id, { scope: 'ai_chat', revoked: true });
    await H.seedConsent(prisma, u3.id, { scope: 'ai_chat', revoked: false });
    assert.strictEqual(await hasChatConsent(prisma, u3.id), true);
    // ativa + revogada (ordem inversa) → ainda true (ordem-independente)
    const u4 = await H.seedUser(prisma, {});
    await H.seedConsent(prisma, u4.id, { scope: 'ai_chat', revoked: false });
    await H.seedConsent(prisma, u4.id, { scope: 'ai_chat', revoked: true });
    assert.strictEqual(await hasChatConsent(prisma, u4.id), true);
    // só ai_insights ativa → false (escopo errado)
    const u5 = await H.seedUser(prisma, {});
    await H.seedConsent(prisma, u5.id, { scope: 'ai_insights', revoked: false });
    assert.strictEqual(await hasChatConsent(prisma, u5.id), false);
  });

  test('C8/D1C-4 · posse escopada por (id,userId): alheio e inexistente → null (404 unificado)', async () => {
    const { prisma } = ctx;
    const uA = await H.seedUser(prisma, {});
    const uB = await H.seedUser(prisma, {});
    const convB = await H.seedConversation(prisma, uB.id);
    assert.ok(await findOwnedConversation(prisma, { conversationId: convB.id, userId: uB.id }), 'dono encontra');
    assert.strictEqual(await findOwnedConversation(prisma, { conversationId: convB.id, userId: uA.id }), null, 'cross-tenant → null');
    assert.strictEqual(await findOwnedConversation(prisma, { conversationId: 'inexistente', userId: uA.id }), null, 'inexistente → null');
  });

  test('C7 · rate-limit: permite até o teto, bloqueia acima, reseta na janela (ortogonal à cota)', async () => {
    const rl = createRateLimiter({ windowMs: 1000, maxInWindow: 2, failOpen: true });
    const t0 = 1000;
    assert.strictEqual(rl.check('u', t0).allowed, true);
    assert.strictEqual(rl.check('u', t0).allowed, true);
    const denied = rl.check('u', t0);
    assert.strictEqual(denied.allowed, false);
    assert.ok(denied.retryAfterMs > 0);
    // janela reseta → permite de novo (sem creditar cota — é só o bucket)
    assert.strictEqual(rl.check('u', t0 + 1000).allowed, true);
  });

  test('C7 · fail-open/closed explícito quando o limiter não pode decidir (key ausente)', () => {
    assert.strictEqual(createRateLimiter({ failOpen: true }).check(null).allowed, true);
    assert.strictEqual(createRateLimiter({ failOpen: false }).check(null).allowed, false);
  });

  test('C8/D1C-6 · derivação de plano vem do user autenticado (pro/isPremium→pro; demais→free)', () => {
    assert.strictEqual(derivePlan({ plan: 'pro' }), 'pro');
    assert.strictEqual(derivePlan({ isPremium: true }), 'pro');
    assert.strictEqual(derivePlan({ plan: 'free' }), 'free');
    assert.strictEqual(derivePlan({ plan: 'premium', isPremium: true }), 'pro');
    assert.strictEqual(derivePlan({}), 'free'); // fail-safe (menor limite)
  });
};
