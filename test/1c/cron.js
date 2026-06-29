'use strict';

// [Consultor · 1C] C8 — Cron de reconciliação RESILIENTE (D1C-9 / R1C-3).
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { runChatReconciliationCron } = require('../../src/jobs/chatReconciliationCron');
const { admitTurn } = require('../../src/services/chat/chatQuotaService');

const NOW = '2026-06-26T12:00:00.000Z';
const DAY = '2026-06-26';
const silentLogger = { error() {}, warn() {}, log() {} };

async function seedStaleUser(prisma) {
  const u = await H.seedUser(prisma, {});
  const conv = await H.seedConversation(prisma, u.id);
  const adm = await admitTurn(prisma, { userId: u.id, conversationId: conv.id, idempotencyKey: 'k0000000000000001', userMessage: 'oi', plan: 'free', nowIso: NOW });
  await H.backdateTurn(prisma, adm.turn.id, { updatedAtSecAgo: H.TTL + 60 });
  return u;
}

module.exports = (ctx) => {
  test('C8 · cron reconcilia múltiplos usuários stale → drift 0 por usuário', async () => {
    const { prisma } = ctx;
    const users = [await seedStaleUser(prisma), await seedStaleUser(prisma)];
    const out = await runChatReconciliationCron(prisma, { metrics: H.metrics(), logger: silentLogger });
    assert.strictEqual(out.usersScanned, 2);
    assert.strictEqual(out.refunded, 2);
    assert.strictEqual(out.failedUsers, 0);
    for (const u of users) {
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
      await H.assertDriftZero(assert, prisma, u.id, DAY, null);
    }
  });

  test('C8/R1C-3 · isolação por-usuário: um usuário venenoso NÃO aborta o lote', async () => {
    const { prisma } = ctx;
    await seedStaleUser(prisma); await seedStaleUser(prisma); await seedStaleUser(prisma);
    let processed = 0;
    // reconcileFn injetado: o 2º usuário processado lança; os demais seguem.
    const reconcileFn = async (_p, { userId }) => {
      processed += 1;
      if (processed === 2) throw new Error('usuário venenoso (erro persistente)');
      return { scanned: 1, refunded: 1 };
    };
    const out = await runChatReconciliationCron(prisma, { reconcileFn, metrics: H.metrics(), logger: silentLogger });
    assert.strictEqual(out.usersScanned, 3);
    assert.strictEqual(out.failedUsers, 1, 'o erro de 1 usuário é isolado');
    assert.strictEqual(out.refunded, 2, 'os outros 2 usuários foram processados (lote não abortou)');
  });

  test('C8-CRON-CAP · cap NÃO-silencioso: lote no limite sinaliza truncated', async () => {
    const { prisma } = ctx;
    await seedStaleUser(prisma); await seedStaleUser(prisma);
    const out = await runChatReconciliationCron(prisma, { batchSize: 1, metrics: H.metrics(), logger: silentLogger });
    assert.strictEqual(out.usersScanned, 1);
    assert.strictEqual(out.truncated, true, 'usersScanned==batchSize → backlog sinalizado');
  });

  test('C8 · cron idempotente: 2ª passada não dupla-reembolsa', async () => {
    const { prisma } = ctx;
    const u = await seedStaleUser(prisma);
    const a = await runChatReconciliationCron(prisma, { logger: silentLogger });
    const b = await runChatReconciliationCron(prisma, { logger: silentLogger });
    assert.strictEqual(a.refunded, 1);
    assert.strictEqual(b.refunded, 0, 'segunda passada é no-op');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });
};
