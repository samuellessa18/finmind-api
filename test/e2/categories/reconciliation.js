'use strict';

// [Consultor · E2] Categoria 5 — Reconciliação (lazy + cron, idempotente, sob advisory lock).
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('../harness');
const { admitTurn, dispatchTurn, billTurn, refundTurn } = require('../../../src/services/chat/chatQuotaService');
const { reconcileUserLazy, reconcileCron } = require('../../../src/services/chat/chatReconciliationService');

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
  test('REC-LAZY-01 · lazy resolve ADMITTED stale → REFUNDED na próxima request', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await H.backdateTurn(prisma, r.turn.id, { updatedAtSecAgo: H.TTL + 60 });
    const rec = await reconcileUserLazy(prisma, { userId: u.id });
    assert.strictEqual(rec.scanned, 1); assert.strictEqual(rec.refunded, 1);
    const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.state, 'REFUNDED');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });

  test('REC-LAZY-02 · lazy resolve DISPATCHING stale → ERROR (rows-affected=0 no limite, R16)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    // exatamente no limite inferior (now=NOW, janela ancorada em providerCallStartedAt=NOW): NÃO stale
    const atLimit = await reconcileUserLazy(prisma, { userId: u.id, nowIso: NOW });
    assert.strictEqual(atLimit.refunded, 0, 'no limite inferior, rows-affected=0');
    // além da janela → ERROR
    const past = H.isoPlus(NOW, H.LLM_SEC * 1000 + 1000);
    const rec = await reconcileUserLazy(prisma, { userId: u.id, nowIso: past });
    assert.strictEqual(rec.refunded, 1);
    const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.state, 'ERROR');
    await H.assertDriftZero(assert, prisma, u.id, DAY, past);
  });

  test('REC-CRON-01 · cron varre o índice parcial → drift 0 por usuário', async () => {
    const { prisma } = ctx;
    const users = [];
    for (let i = 0; i < 4; i++) {
      const { u, conv } = await setup(ctx);
      const r = await admit(prisma, u.id, conv.id, 'k', 'm');
      await H.backdateTurn(prisma, r.turn.id, { updatedAtSecAgo: H.TTL + 60 });
      users.push(u);
    }
    const out = await reconcileCron(prisma, {});
    assert.strictEqual(out.usersScanned, 4);
    assert.strictEqual(out.refunded, 4);
    for (const u of users) {
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
      await H.assertDriftZero(assert, prisma, u.id, DAY, null);
    }
  });

  test('REC-STUCK-01 · turno preso (crash do provider) → reconcilia ao terminal, libera 1 cota', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    await H.backdateTurn(prisma, r.turn.id, { providerStartedSecAgo: H.LLM_SEC + 600 });
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    const rec = await reconcileUserLazy(prisma, { userId: u.id });
    assert.strictEqual(rec.refunded, 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, 'liberou 1 cota');
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });

  test('REC-RESTART-01 · restart com turnos em voo → resolve stale, preserva frescos (sem vazar/perder)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx, 'pro');
    const stale = await admit(prisma, u.id, conv.id, 'ks', 'ms', NOW, 'pro');
    const fresh = await admit(prisma, u.id, conv.id, 'kf', 'mf', NOW, 'pro');
    await dispatchTurn(prisma, { turnId: stale.turn.id, userId: u.id, nowIso: NOW });
    await H.backdateTurn(prisma, stale.turn.id, { providerStartedSecAgo: H.LLM_SEC + 60 });
    // "restart": cron varre tudo
    const out = await reconcileCron(prisma, {});
    assert.strictEqual(out.refunded, 1, 'só o stale reembolsa');
    const ts = await prisma.chatTurn.findUnique({ where: { id: stale.turn.id } });
    const tf = await prisma.chatTurn.findUnique({ where: { id: fresh.turn.id } });
    assert.strictEqual(ts.state, 'ERROR');
    assert.strictEqual(tf.state, 'ADMITTED', 'turno fresco preservado');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1, 'cota do fresco intacta; do stale liberada');
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });

  test('REC-IDEMP-01 · reconciliação 2× mesmo turno → não dupla-reembolsa', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await H.backdateTurn(prisma, r.turn.id, { updatedAtSecAgo: H.TTL + 60 });
    const a = await reconcileUserLazy(prisma, { userId: u.id });
    const b = await reconcileUserLazy(prisma, { userId: u.id });
    assert.strictEqual(a.refunded, 1);
    assert.strictEqual(b.refunded, 0, 'segunda passada é no-op');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });

  test('REC-RACE-01 · reconciliação × BILLED concorrente → 1 transição vence (spy do lock, R18)', async () => {
    const { prisma, capture } = ctx;
    let billedWins = 0; let errorWins = 0;
    for (let rep = 0; rep < 12; rep++) {
      await H.reset(prisma);
      const { u, conv } = await setup(ctx);
      const r = await admit(prisma, u.id, conv.id, 'k', 'm');
      await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
      await H.backdateTurn(prisma, r.turn.id, { providerStartedSecAgo: H.LLM_SEC + 60 }); // stale → reconcile agiria
      const useSpy = rep === 0;
      if (useSpy) capture.start();
      // alterna a ordem de largada por rep p/ exercer AMBOS os lados da corrida (cobertura honesta)
      const billFirst = rep % 2 === 0;
      const res = await H.makeBarrier().run(2, (i) => (i === 0) === billFirst
        ? billTurn(prisma, { turnId: r.turn.id, userId: u.id, assistantContent: 'r', nowIso: NOW })
        : reconcileUserLazy(prisma, { userId: u.id }));
      if (useSpy) { capture.stop(); assert.ok(capture.advisoryLocks() >= 2, `ambos caminhos adquirem o lock (viu ${capture.advisoryLocks()})`); }
      const rejected = res.filter((x) => x.status === 'rejected').length;
      assert.strictEqual(rejected, 0, 'deadlock_count=0 (sem 40P01 vazado)');
      const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
      assert.ok(t.state === 'BILLED' || t.state === 'ERROR', 'exatamente um terminal');
      if (t.state === 'BILLED') { billedWins += 1; assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1); }
      else { errorWins += 1; assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0); }
      await H.assertDriftZero(assert, prisma, u.id, DAY, null);
    }
    // log de cobertura: ambos os lados da corrida observados ao longo das reps (não silencioso)
    console.log(`    [REC-RACE-01] billedWins=${billedWins} errorWins=${errorWins} (12 reps)`);
  });

  test('REC-RACE-02 · 40001 na reconciliação → retry, sem corromper cota', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await H.backdateTurn(prisma, r.turn.id, { updatedAtSecAgo: H.TTL + 60 });
    let attempts = 0; let retries = 0;
    const rec = await reconcileUserLazy(prisma, { userId: u.id }, {
      afterLock: async () => { attempts += 1; if (attempts === 1) throw H.pgError('40001'); },
      onRetry: () => { retries += 1; },
    });
    assert.strictEqual(retries, 1);
    assert.strictEqual(rec.refunded, 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });

  test('RACE-LAZY-CRON-01 · lazy × cron mesmo turno → exatamente 1 rows-affected=1 (R1)', async () => {
    const { prisma } = ctx;
    for (let rep = 0; rep < 20; rep++) {
      await H.reset(prisma);
      const { u, conv } = await setup(ctx);
      const r = await admit(prisma, u.id, conv.id, 'k', 'm');
      await H.backdateTurn(prisma, r.turn.id, { updatedAtSecAgo: H.TTL + 60 });
      const res = await H.makeBarrier().run(2, (i) => i === 0
        ? reconcileUserLazy(prisma, { userId: u.id })
        : reconcileCron(prisma, {}));
      const totalRefunded = res.reduce((acc, x) => acc + (x.status === 'fulfilled' ? x.value.refunded : 0), 0);
      assert.strictEqual(totalRefunded, 1, `rep ${rep}: exatamente 1 reembolso entre lazy e cron`);
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
      await H.assertDriftZero(assert, prisma, u.id, DAY, null);
    }
  });

  test('RACE-DISPATCH-REFUND-01 · ADMITTED→DISPATCHING × refund → mutuamente exclusivo, count nunca −2', async () => {
    const { prisma } = ctx;
    for (let rep = 0; rep < 20; rep++) {
      await H.reset(prisma);
      const { u, conv } = await setup(ctx);
      const r = await admit(prisma, u.id, conv.id, 'k', 'm');
      const res = await H.makeBarrier().run(2, (i) => i === 0
        ? dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW })
        : refundTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW }));
      const rejected = res.filter((x) => x.status === 'rejected').length;
      assert.strictEqual(rejected, 0);
      const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
      assert.strictEqual(t.state, 'REFUNDED', 'refund sempre vence o estado final (ADMITTED ou DISPATCHING → REFUNDED)');
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, 'exatamente 1 decremento (nunca −2)');
      await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    }
  });

  test('TERM-EXIT-01 · saída de cada terminal não-refund → rows-affected=0, estado inalterado (R7)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx, 'pro');
    // BILLED: dispatch/refund não saem
    const a = await admit(prisma, u.id, conv.id, 'kb', 'm', NOW, 'pro');
    await dispatchTurn(prisma, { turnId: a.turn.id, userId: u.id, nowIso: NOW });
    await billTurn(prisma, { turnId: a.turn.id, userId: u.id, assistantContent: 'r', nowIso: NOW });
    assert.strictEqual((await dispatchTurn(prisma, { turnId: a.turn.id, userId: u.id, nowIso: NOW })).casRows, 0);
    assert.strictEqual((await refundTurn(prisma, { turnId: a.turn.id, userId: u.id, nowIso: NOW })).casRows, 0);
    assert.strictEqual((await prisma.chatTurn.findUnique({ where: { id: a.turn.id } })).state, 'BILLED');
    // REFUNDED: dispatch/refund/bill não saem
    const b = await admit(prisma, u.id, conv.id, 'kr', 'm', NOW, 'pro');
    await refundTurn(prisma, { turnId: b.turn.id, userId: u.id, nowIso: NOW });
    assert.strictEqual((await dispatchTurn(prisma, { turnId: b.turn.id, userId: u.id, nowIso: NOW })).casRows, 0);
    assert.strictEqual((await refundTurn(prisma, { turnId: b.turn.id, userId: u.id, nowIso: NOW })).casRows, 0);
    assert.strictEqual((await billTurn(prisma, { turnId: b.turn.id, userId: u.id, assistantContent: 'r', nowIso: NOW })).casRows, 0);
    assert.strictEqual((await prisma.chatTurn.findUnique({ where: { id: b.turn.id } })).state, 'REFUNDED');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('BILLED-VS-REFUND-RETRY-WINDOW · BILLED vence entre rollback e retry do refund → CAS 0, não reverte (R11)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    let firstAttempt = true; let retries = 0; let billPromise = null;
    const ref = await refundTurn(
      prisma,
      { turnId: r.turn.id, userId: u.id, nowIso: NOW },
      {
        // 1ª tentativa: dispara um BILLED concorrente (fica enfileirado no nosso lock) e força 40001.
        // Ao dar rollback, liberamos o lock → o BILLED (já enfileirado) vence antes do retry.
        afterLock: async () => {
          if (firstAttempt) {
            firstAttempt = false;
            billPromise = billTurn(prisma, { turnId: r.turn.id, userId: u.id, assistantContent: 'resp', nowIso: NOW });
            throw H.pgError('40001', 'janela rollback↔retry');
          }
        },
        onRetry: () => { retries += 1; },
      },
    );
    const billRes = await billPromise;
    assert.strictEqual(billRes.billed, true, 'o BILLED concorrente venceu');
    assert.ok(retries >= 1, 'o refund sofreu retry de 40001');
    assert.strictEqual(ref.casRows, 0, 'retry re-avalia: CAS 0 (turno já BILLED)');
    assert.strictEqual(ref.decremented, false);
    const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.state, 'BILLED', 'BILLED não revertido');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1, 'cota retida (não reembolsada)');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });
};
