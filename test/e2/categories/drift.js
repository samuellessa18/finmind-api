'use strict';

// [Consultor · E2] Categoria 3 — Drift (C == B + A + D + S).
// Prova matemática (identidade contábil derivada DO DB) + operacional (recomputa do banco
// ao fim de cada cenário). assertDriftZero (selado, S-aware) é a asserção final OBRIGATÓRIA (R2).
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('../harness');
const { admitTurn, dispatchTurn, billTurn, refundTurn } = require('../../../src/services/chat/chatQuotaService');
const { reconcileUserLazy } = require('../../../src/services/chat/chatReconciliationService');

const NOW = '2026-06-26T12:00:00.000Z';
const DAY = '2026-06-26';
const LLM_MS = H.LLM_SEC * 1000;
const TTL_MS = H.TTL * 1000;

async function setup(ctx, plan = 'free') {
  const u = await H.seedUser(ctx.prisma, { plan });
  const conv = await H.seedConversation(ctx.prisma, u.id);
  return { u, conv };
}
const admit = (prisma, u, c, key, msg, nowIso = NOW, plan = 'free') =>
  admitTurn(prisma, { userId: u, conversationId: c, idempotencyKey: key, userMessage: msg, plan, nowIso });

module.exports = (ctx) => {
  test('DRIFT-ASSERTER-01 · o asserter selado é S-aware e derivado do DB', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    await admit(prisma, u.id, conv.id, 'k', 'm');
    const x = await H.driftSnapshot(prisma, u.id, DAY, NOW);
    assert.strictEqual(x.c, 1); assert.strictEqual(x.a, 1);
    assert.strictEqual(x.sum, x.b + x.a + x.d + x.s);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('DRIFT-ADMIT-01 · admissão pura → C=A, drift 0', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    await admit(prisma, u.id, conv.id, 'k', 'm');
    const x = await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    assert.strictEqual(x.a, x.c); assert.strictEqual(x.b, 0);
    assert.strictEqual(x.d, 0); assert.strictEqual(x.s, 0);
  });

  test('DRIFT-BILLED-01 · admit→DISPATCHING→BILLED → C=B, cota retida', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    await billTurn(prisma, { turnId: r.turn.id, userId: u.id, assistantContent: 'resp', nowIso: NOW });
    const x = await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    assert.strictEqual(x.b, 1); assert.strictEqual(x.c, 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1, 'BILLED retém a cota');
  });

  test('DRIFT-REFUND-01 · refund DISPATCHING→REFUNDED → count-1 atômico, S=0', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    const ref = await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, terminal: 'REFUNDED', nowIso: NOW });
    assert.strictEqual(ref.decremented, true);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    const x = await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    assert.strictEqual(x.s, 0); assert.strictEqual(x.c, 0);
  });

  test('DRIFT-REFUND-IDEMP-01 · 2ª chamada em turno terminal → no-op (R22)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    const r1 = await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    const r2 = await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    assert.strictEqual(r1.decremented, true);
    assert.strictEqual(r1.casRows, 1);
    assert.strictEqual(r2.decremented, false, 'R22: CAS rows-affected=0 NÃO decrementa');
    assert.strictEqual(r2.casRows, 0);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, 'count cai 1×, nunca 2×');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('DRIFT-ERROR-01 · ERROR refundante → mecânica=REFUNDED, billedAt NULL', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    const ref = await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, terminal: 'ERROR', nowIso: NOW });
    assert.strictEqual(ref.decremented, true);
    const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.state, 'ERROR');
    assert.strictEqual(t.billedAt, null, 'turno ERROR tem billedAt IS NULL');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('DRIFT-TIMEOUT-01 · timeout → S → reconciliação zera (relógio do Postgres, R16)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    // envelhece pelo relógio REAL do Postgres (dessincroniza do Node — R16)
    await H.backdateTurn(prisma, r.turn.id, { providerStartedSecAgo: H.LLM_SEC + 60 });
    // classificação por now() do Postgres: o turno é S (DISPATCHING fora da janela)
    const before = await H.driftSnapshot(prisma, u.id, DAY, null);
    assert.strictEqual(before.s, 1, 'DISPATCHING fora da janela = S');
    assert.strictEqual(before.d, 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, null); // C=1=S → drift 0 mesmo stale
    const rec = await reconcileUserLazy(prisma, { userId: u.id }); // nowIso=null → Postgres now()
    assert.strictEqual(rec.refunded, 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });

  test('DRIFT-STALE-ADMITTED-01 · ADMITTED idade>TTL → S → reconciliação zera', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await H.backdateTurn(prisma, r.turn.id, { updatedAtSecAgo: H.TTL + 60 });
    const before = await H.driftSnapshot(prisma, u.id, DAY, null);
    assert.strictEqual(before.s, 1, 'ADMITTED stale = S');
    assert.strictEqual(before.a, 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
    const rec = await reconcileUserLazy(prisma, { userId: u.id });
    assert.strictEqual(rec.refunded, 1);
    const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.state, 'REFUNDED', 'ADMITTED stale → REFUNDED');
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });

  test('DRIFT-CRASH-01 · crash DISPATCHING (sem BILLED) → órfão→S→restaura', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW }); // "crash" antes do bill
    await H.backdateTurn(prisma, r.turn.id, { providerStartedSecAgo: H.LLM_SEC + 60 });
    const rec = await reconcileUserLazy(prisma, { userId: u.id });
    assert.strictEqual(rec.refunded, 1);
    const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.state, 'ERROR', 'DISPATCHING órfão → ERROR (terminal refundante)');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });

  test('DRIFT-DBFAIL-ADMIT-01 · falha de DB na admissão → rollback, sem incremento órfão', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    await assert.rejects(() => admitTurn(
      prisma,
      { userId: u.id, conversationId: conv.id, idempotencyKey: 'k', userMessage: 'm', plan: 'free', nowIso: NOW },
      { afterQuota: async () => { throw new Error('db boom (não-retryável)'); } },
    ));
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, 'count revertido (sem cota fantasma)');
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('DRIFT-LIMIT-429-01 · limite estourado → 429, drift inalterado', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    for (let i = 0; i < 5; i++) await admit(prisma, u.id, conv.id, 'k' + i, 'm' + i);
    const over = await admit(prisma, u.id, conv.id, 'k5', 'm5');
    assert.strictEqual(over.outcome, 'LIMIT');
    assert.strictEqual(over.httpStatus, 429);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 5);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('DRIFT-CONC-500-01 · 500 admit/refund/timeout paralelos → C==B+A+D+S (do DB, R15)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx, 'pro'); // L=50
    // 50 admitidas (limite), depois um mix de bill/refund/timeout sobre elas.
    const res = await H.makeBarrier().run(500, (i) => admit(prisma, u.id, conv.id, 'k' + i, 'm' + i, NOW, 'pro'));
    const admitted = res.filter((x) => x.status === 'fulfilled' && x.value.outcome === 'ADMITTED').map((x) => x.value.turn);
    assert.strictEqual(admitted.length, 50);
    // mix determinístico: 1/3 BILLED, 1/3 REFUNDED, 1/3 timeout→ERROR via reconcile
    for (let i = 0; i < admitted.length; i++) {
      const id = admitted[i].id;
      if (i % 3 === 0) {
        await dispatchTurn(prisma, { turnId: id, userId: u.id, nowIso: NOW });
        await billTurn(prisma, { turnId: id, userId: u.id, assistantContent: 'r', nowIso: NOW });
      } else if (i % 3 === 1) {
        await refundTurn(prisma, { turnId: id, userId: u.id, nowIso: NOW });
      } else {
        await dispatchTurn(prisma, { turnId: id, userId: u.id, nowIso: NOW });
        await H.backdateTurn(prisma, id, { providerStartedSecAgo: H.LLM_SEC + 60 });
      }
    }
    await reconcileUserLazy(prisma, { userId: u.id }); // resolve os timeouts (S→ERROR)
    const x = await H.assertDriftZero(assert, prisma, u.id, DAY, null);
    assert.strictEqual(x.s, 0, 'pós-reconcile S=0');
    // identidade derivada do DB: C == B + A + D + S (proibido contador de aplicação, R15)
    assert.strictEqual(x.c, x.b + x.a + x.d + x.s);
  });

  test('DRIFT-PROP-01 · sequência aleatória (property-based) → invariante mantido', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx, 'pro');
    // PRNG seedado (reprodutível): LCG
    let seed = 0x9e3779b1;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const live = []; // turnos ainda não-terminais
    for (let step = 0; step < 120; step++) {
      const op = rnd();
      if (op < 0.5 || live.length === 0) {
        const r = await admit(prisma, u.id, conv.id, 'k' + step, 'm' + step, NOW, 'pro');
        if (r.outcome === 'ADMITTED') live.push({ id: r.turn.id, state: 'ADMITTED' });
      } else if (op < 0.7) {
        const t = live[Math.floor(rnd() * live.length)];
        if (t.state === 'ADMITTED') { await dispatchTurn(prisma, { turnId: t.id, userId: u.id, nowIso: NOW }); t.state = 'DISPATCHING'; }
      } else if (op < 0.85) {
        const idx = Math.floor(rnd() * live.length); const t = live[idx];
        if (t.state === 'DISPATCHING') { await billTurn(prisma, { turnId: t.id, userId: u.id, assistantContent: 'r', nowIso: NOW }); live.splice(idx, 1); }
      } else {
        const idx = Math.floor(rnd() * live.length); const t = live[idx];
        // refund pode ser chamado 2× (no-op na 2ª) — R22
        await refundTurn(prisma, { turnId: t.id, userId: u.id, nowIso: NOW });
        await refundTurn(prisma, { turnId: t.id, userId: u.id, nowIso: NOW });
        live.splice(idx, 1);
      }
      await H.assertDriftZero(assert, prisma, u.id, DAY, NOW); // invariante a CADA passo
    }
  });

  test('CHECK-ERROR-BILLEDAT-01 · UPDATE billedAt onde state=REFUNDED → 23514 (R8)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, terminal: 'REFUNDED', nowIso: NOW });
    await assert.rejects(
      () => prisma.$executeRaw`UPDATE "ChatTurn" SET "billedAt" = now() WHERE id = ${r.turn.id}`,
      (e) => {
        const code = (e.meta && String(e.meta.code)) || '';
        assert.ok(code === '23514' || /billed_consistency|23514/.test(e.message), 'check_violation 23514');
        return true;
      },
    );
    const t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.billedAt, null, 'CHECK preservou billedAt NULL em REFUNDED');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('WINDOW-BOUNDARY-01 · providerCallStartedAt == now − LLM_TIMEOUT exato → D, não S (R13)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW }); // providerCallStartedAt = NOW (exato)
    // (a) igualdade exata: now = NOW + LLM_TIMEOUT → NÃO é stale (limite inferior, rows-affected=0)
    const atBoundary = H.isoPlus(NOW, LLM_MS);
    const recAt = await reconcileUserLazy(prisma, { userId: u.id, nowIso: atBoundary });
    assert.strictEqual(recAt.refunded, 0, 'na igualdade exata NÃO reembolsa (D, não S)');
    let t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.state, 'DISPATCHING');
    const xb = await H.driftSnapshot(prisma, u.id, DAY, atBoundary);
    assert.strictEqual(xb.d, 1); assert.strictEqual(xb.s, 0);
    assert.strictEqual(xb.c, xb.sum);
    // (b) 1s além do limite → vira S → reconcilia (ERROR)
    const past = H.isoPlus(NOW, LLM_MS + 1000);
    const recPast = await reconcileUserLazy(prisma, { userId: u.id, nowIso: past });
    assert.strictEqual(recPast.refunded, 1, 'além do limite reembolsa');
    t = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(t.state, 'ERROR');
    await H.assertDriftZero(assert, prisma, u.id, DAY, past);
  });

  test('DAYKEY-ROLLOVER-01 · refund usa o turn.dayKey PERSISTIDO, não now() (R4/D3)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    // admite às 23:59:30 UTC → dayKey persistido = 2026-06-26
    const lateNight = '2026-06-26T23:59:30.000Z';
    const r = await admit(prisma, u.id, conv.id, 'k', 'm', lateNight);
    assert.strictEqual(r.turn.dayKey, '2026-06-26');
    assert.strictEqual(await H.usageCount(prisma, u.id, '2026-06-26'), 1);
    // refund "depois da meia-noite" (now=2026-06-27) — deve decrementar 2026-06-26, NUNCA 2026-06-27
    const afterMidnight = '2026-06-27T00:00:30.000Z';
    const ref = await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: afterMidnight });
    assert.strictEqual(ref.decremented, true);
    assert.strictEqual(await H.usageCount(prisma, u.id, '2026-06-26'), 0, 'decrementou o dayKey persistido');
    assert.strictEqual(await H.usageCount(prisma, u.id, '2026-06-27'), 0, 'NUNCA criou/tocou 2026-06-27');
    await H.assertDriftZero(assert, prisma, u.id, '2026-06-26', lateNight);
  });
};
