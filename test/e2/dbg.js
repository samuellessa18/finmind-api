'use strict';
const H = require('./harness');
const { admitTurn } = require('../../src/services/chat/chatQuotaService');

(async () => {
  const ctx = await H.boot();
  try {
    await H.reset(ctx.prisma);
    const u = await H.seedUser(ctx.prisma, { plan: 'free' });
    const conv = await H.seedConversation(ctx.prisma, u.id);
    console.log('user', u.id, 'conv', conv.id);
    try {
      const r = await admitTurn(ctx.prisma, {
        userId: u.id, conversationId: conv.id, idempotencyKey: 'k1',
        userMessage: 'olá', plan: 'free', nowIso: '2026-06-26T12:00:00.000Z',
      });
      console.log('ADMIT RESULT:', JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (e) {
      console.error('ADMIT THREW:', e && e.message);
      console.error('meta:', e && e.meta);
      console.error(e && e.stack);
    }
  } finally {
    await ctx.stop();
  }
})();
