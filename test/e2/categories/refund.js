'use strict';

// [Consultor · E2] Categoria 4 — Refund (regra única, INV-refund-atômico).
// Decremento na MESMA tx, condicionado a rows-affected=1 do CAS de estado. Idempotente.
// D1: refund também adquire pg_advisory_xact_lock(userId) (ordenação de locks).
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('../harness');
const { admitTurn, dispatchTurn, billTurn, refundTurn } = require('../../../src/services/chat/chatQuotaService');
const { reconcileUserLazy } = require('../../../src/services/chat/chatReconciliationService');

const NOW = '2026-06-26T12:00:00.000Z';
const DAY = '2026-06-26';

async function setup(ctx, plan = 'free') {
  const u = await H.seedUser(ctx.prisma, { plan });
  const conv = await H.seedConversation(ctx.prisma, u.id);
  return { u, conv };
}
const admit = (prisma, u, c, key, msg, nowIso = NOW, plan = 'free') =>
  admitTurn(prisma, { userId: u, conversationId: c, idempotencyKey: key, userMessage: msg, plan, nowIso });

module.exports = (ctx) => {
  test('T-REF-TIMEOUT-01 · refund por timeout (stale) → reembolso', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    await H.backdateTurn(prisma, r.turn.id, { providerStartedSecAgo: H.LLM_SEC + 60 });
    const rec = await reconcileUserLazy(prisma, { userId: u.id });
    assert.strictEqual(rec.refunded, 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });

  test('T-REF-ERROR-01 · refund por ERROR → mecânica=REFUNDED, billedAt NULL', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    const ref = await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, terminal: 'ERROR', nowIso: NOW });
    assert.strictEqual(ref.decremented, true);
    const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.state, 'ERROR'); assert.strictEqual(t.billedAt, null);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('T-REF-TRANS-01 · ADMITTED→REFUNDED (sem dispatch) → decremento efetivo', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    const ref = await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    assert.strictEqual(ref.casRows, 1); assert.strictEqual(ref.decremented, true);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('T-REF-DOUBLE-01 · double refund SEQUENCIAL → no-op, count não cai 2×', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    const a = await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    const b = await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    assert.strictEqual(a.decremented, true);
    assert.strictEqual(b.decremented, false);
    assert.strictEqual(b.outcome, 'NOOP_REFUND');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('T-REF-DOUBLE-CONC-01 · double refund CONCORRENTE mesmo turn → exatamente 1 decremento', async () => {
    const { prisma } = ctx;
    for (let rep = 0; rep < 20; rep++) {
      await H.reset(prisma);
      const { u, conv } = await setup(ctx);
      const r = await admit(prisma, u.id, conv.id, 'k', 'm');
      const res = await H.makeBarrier().run(2, () => refundTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW }));
      const dec = res.filter((x) => x.status === 'fulfilled' && x.value.decremented).length;
      assert.strictEqual(dec, 1, `rep ${rep}: exatamente 1 decremento (rows-affected)`);
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
      await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    }
  });

  test('T-REF-RETRY-01 · refund sob retry (40001) → rollback total + 1 único decremento', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    let attempts = 0; let retries = 0;
    const ref = await refundTurn(
      prisma,
      { turnId: r.turn.id, userId: u.id, nowIso: NOW },
      {
        afterLock: async () => { attempts += 1; if (attempts === 1) throw H.pgError('40001', 'serialization'); },
        onRetry: () => { retries += 1; },
      },
    );
    assert.strictEqual(retries, 1, 'houve 1 retry de serialização');
    assert.strictEqual(ref.decremented, true);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, '1 único decremento apesar do retry');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('T-REF-CAS-BILLED-01 · refund de turn já BILLED → no-op, faturado nunca reembolsado', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    await billTurn(prisma, { turnId: r.turn.id, userId: u.id, assistantContent: 'r', nowIso: NOW });
    const ref = await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    assert.strictEqual(ref.casRows, 0); assert.strictEqual(ref.decremented, false);
    const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.state, 'BILLED');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1, 'BILLED retém cota');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('T-REF-CAS-FLOOR-01 · piso: count nunca < 0 (guarda count>0)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    // zera a cota manualmente, simulando estado inconsistente; o decremento NÃO pode ir a -1
    await prisma.$executeRaw`UPDATE "ChatUsage" SET count = 0 WHERE "userId" = ${u.id} AND "dayKey" = ${DAY}`;
    const { _refundOnTx } = require('../../../src/services/chat/chatQuotaService');
    await prisma.$transaction(async (tx) => {
      const out = await _refundOnTx(tx, { turnId: r.turn.id, userId: u.id, dayKey: DAY, terminal: 'REFUNDED', now: null });
      assert.strictEqual(out.casRows, 1, 'CAS de estado ocorre');
      assert.strictEqual(out.decremented, false, 'mas o decremento é no-op (count já 0)');
    });
    const row = await prisma.chatUsage.findUnique({ where: { userId_dayKey: { userId: u.id, dayKey: DAY } } });
    assert.strictEqual(row.count, 0, 'count nunca negativo');
  });

  test('T-REF-DRIFT-01 · drift pós-refund → C==B+A+D+S, S=0', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx, 'pro');
    const turns = [];
    for (let i = 0; i < 6; i++) { const r = await admit(prisma, u.id, conv.id, 'k' + i, 'm' + i, NOW, 'pro'); turns.push(r.turn.id); }
    for (let i = 0; i < 3; i++) await refundTurn(prisma, { turnId: turns[i], userId: u.id, nowIso: NOW });
    const x = await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    assert.strictEqual(x.s, 0);
    assert.strictEqual(x.c, 3); assert.strictEqual(x.a, 3);
  });

  test('REFUND-CONCORRENTE-DOIS-TURNS-MESMO-USAGE · 2 turnos do mesmo (user,day) em paralelo → count cai 2 (R1/D1)', async () => {
    const { prisma, capture } = ctx;
    for (let rep = 0; rep < 20; rep++) {
      await H.reset(prisma);
      const { u, conv } = await setup(ctx);
      const r1 = await admit(prisma, u.id, conv.id, 'k1', 'm1');
      const r2 = await admit(prisma, u.id, conv.id, 'k2', 'm2');
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 2);
      const useSpy = rep === 0;
      if (useSpy) capture.start();
      const res = await H.makeBarrier().run(2, (i) =>
        refundTurn(prisma, { turnId: i === 0 ? r1.turn.id : r2.turn.id, userId: u.id, nowIso: NOW }));
      if (useSpy) {
        capture.stop();
        assert.ok(capture.advisoryLocks() >= 2, `D1: ambos refunds adquirem o advisory lock (viu ${capture.advisoryLocks()})`);
      }
      const dec = res.filter((x) => x.status === 'fulfilled' && x.value.decremented).length;
      assert.strictEqual(dec, 2, `rep ${rep}: 2 decrementos (turnos distintos, mesma linha ChatUsage)`);
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, 'count cai exatamente 2 → 0');
      await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    }
  });
};
