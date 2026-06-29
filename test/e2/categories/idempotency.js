'use strict';

// [Consultor · E2] Categoria 2 — Idempotência.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('../harness');
const { admitTurn, dispatchTurn, billTurn, refundTurn } = require('../../../src/services/chat/chatQuotaService');
const { httpStatusForError } = require('../../../src/services/chat/chatErrors');

const NOW = '2026-06-26T12:00:00.000Z';
const DAY = '2026-06-26';

async function setup(ctx, plan = 'free') {
  const u = await H.seedUser(ctx.prisma, { plan });
  const conv = await H.seedConversation(ctx.prisma, u.id);
  return { u, conv };
}
const admit = (prisma, u, c, key, msg, nowIso = NOW) =>
  admitTurn(prisma, { userId: u, conversationId: c, idempotencyKey: key, userMessage: msg, plan: 'free', nowIso });

module.exports = (ctx) => {
  test('IDEM-01 · replay mesma key+conteúdo → mesmo turn, sem 2º débito', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r1 = await admit(prisma, u.id, conv.id, 'k', 'oi');
    const r2 = await admit(prisma, u.id, conv.id, 'k', 'oi');
    assert.strictEqual(r1.outcome, 'ADMITTED');
    assert.ok(['IN_FLIGHT', 'REPLAY'].includes(r2.outcome));
    assert.strictEqual(r2.turn.id, r1.turn.id);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('IDEM-02 · replay após crash (commit ok) → não debita de novo', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r1 = await admit(prisma, u.id, conv.id, 'k', 'oi'); // "crash" logo após o commit
    const r2 = await admit(prisma, u.id, conv.id, 'k', 'oi'); // retry do cliente
    assert.strictEqual(r2.turn.id, r1.turn.id);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 1);
  });

  test('IDEM-03 · replay DURANTE DISPATCHING → 202 in-flight, sem novo turn/débito', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r1 = await admit(prisma, u.id, conv.id, 'k', 'oi');
    await dispatchTurn(prisma, { turnId: r1.turn.id, userId: u.id, nowIso: NOW });
    const r2 = await admit(prisma, u.id, conv.id, 'k', 'oi');
    assert.strictEqual(r2.outcome, 'IN_FLIGHT');
    assert.strictEqual(r2.httpStatus, 202);
    assert.strictEqual(r2.turn.id, r1.turn.id);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
  });

  test('IDEM-04 · replay após BILLED → 200 idempotente, sem débito', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r1 = await admit(prisma, u.id, conv.id, 'k', 'oi');
    await dispatchTurn(prisma, { turnId: r1.turn.id, userId: u.id, nowIso: NOW });
    await billTurn(prisma, { turnId: r1.turn.id, userId: u.id, assistantContent: 'resp', nowIso: NOW });
    const r2 = await admit(prisma, u.id, conv.id, 'k', 'oi');
    assert.strictEqual(r2.outcome, 'REPLAY');
    assert.strictEqual(r2.httpStatus, 200);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('IDEM-05 · replay requestHash DIFERENTE mesma key → 409, nunca serve a antiga', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r1 = await admit(prisma, u.id, conv.id, 'k', 'conteúdo-A');
    const r2 = await admit(prisma, u.id, conv.id, 'k', 'conteúdo-B'); // mesma key, conteúdo diferente
    assert.strictEqual(r2.outcome, 'CONFLICT');
    assert.strictEqual(r2.httpStatus, 409);
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    assert.strictEqual(r2.turn.id, r1.turn.id); // referencia a existente, mas marca conflito
  });

  test('IDEM-06 · replay após REFUNDED → não reanima, não re-debita (count estável)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r1 = await admit(prisma, u.id, conv.id, 'k', 'oi');
    await refundTurn(prisma, { turnId: r1.turn.id, userId: u.id, terminal: 'REFUNDED', nowIso: NOW });
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    const r2 = await admit(prisma, u.id, conv.id, 'k', 'oi');
    assert.strictEqual(r2.outcome, 'REPLAY'); // terminal servido idempotente
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 1);
    const t = await prisma.chatTurn.findUnique({ where: { id: r1.turn.id } });
    assert.strictEqual(t.state, 'REFUNDED'); // não reanimado
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0); // sem re-débito
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('IDEM-07 · N=50 concorrentes mesma key (3×) → sempre 1 turn, 1 débito', async () => {
    const { prisma } = ctx;
    for (let rep = 0; rep < 3; rep++) {
      await H.reset(prisma);
      const { u, conv } = await setup(ctx);
      const results = await H.makeBarrier().run(50, () => admit(prisma, u.id, conv.id, 'SAME', 'igual'));
      const admitted = results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'ADMITTED').length;
      const errored = results.filter((r) => r.status === 'rejected').length;
      assert.strictEqual(admitted, 1, `rep ${rep}: exatamente 1 admissão`);
      assert.strictEqual(errored, 0, `rep ${rep}: zero 5xx`);
      assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 1);
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    }
  });

  test('IDEM-08 · turno pré-existente mesma key → re-lookup determinístico (replay)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r1 = await admit(prisma, u.id, conv.id, 'k', 'oi');
    const r2 = await admit(prisma, u.id, conv.id, 'k', 'oi');
    assert.strictEqual(r2.turn.id, r1.turn.id);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
  });

  test('ADMIT-NO-IDEMPOTENCY-KEY · admissão sem key → 400 (D2), sem efeito', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    for (const bad of [null, undefined, '']) {
      await assert.rejects(
        () => admitTurn(prisma, { userId: u.id, conversationId: conv.id, idempotencyKey: bad, userMessage: 'oi', plan: 'free', nowIso: NOW }),
        (e) => { assert.strictEqual(httpStatusForError(e), 400); return true; }
      );
    }
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 0);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
  });

  test('REPLAY-CONFLICT-DURING-DISPATCHING · 409 tem precedência sobre 202 in-flight (R10)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r1 = await admit(prisma, u.id, conv.id, 'k', 'A');
    await dispatchTurn(prisma, { turnId: r1.turn.id, userId: u.id, nowIso: NOW }); // turno in-flight DISPATCHING
    const r2 = await admit(prisma, u.id, conv.id, 'k', 'B'); // requestHash diferente
    assert.strictEqual(r2.outcome, 'CONFLICT', 'conflito precede in-flight');
    assert.strictEqual(r2.httpStatus, 409);
    const t = await prisma.chatTurn.findUnique({ where: { id: r1.turn.id } });
    assert.strictEqual(t.state, 'DISPATCHING'); // intacto
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
  });

  test('CROSS-TENANT-REPLAY · A não consegue replay do turno de B; same-user segue funcionando (E2.2, anti-IDOR)', async () => {
    const { prisma } = ctx;
    const uA = await H.seedUser(prisma, { plan: 'free' });
    const uB = await H.seedUser(prisma, { plan: 'free' });
    const convB = await H.seedConversation(prisma, uB.id);

    // B admite um turno com uma idempotencyKey
    const rB = await admitTurn(prisma, { userId: uB.id, conversationId: convB.id, idempotencyKey: 'shared-key', userMessage: 'segredo do B', plan: 'free', nowIso: NOW });
    assert.strictEqual(rB.outcome, 'ADMITTED');
    assert.strictEqual(await H.usageCount(prisma, uB.id, DAY), 1);

    // A tenta usar a conversa de B + a MESMA idempotencyKey + o MESMO conteúdo (pior caso p/ vazamento).
    // Com o dedupe e o re-lookup escopados por userId, A NUNCA recebe o turno de B. A admissão falha
    // FECHADA: reusando a key de B colide no unique (conversationId,idempotencyKey) → 23505 → re-lookup
    // escopado por uA acha NADA → relança (HTTP 409); com key nova cairia na FK composta (23503 → 503).
    // Em ambos os casos: sem replay, sem vazar o turno de B. (O 403/404 ideal é a checagem de posse
    // da rota da 1C — contrato a montante; aqui o motor garante a defesa em profundidade.)
    let threw = false; let leaked = null; let status = null;
    try {
      leaked = await admitTurn(prisma, { userId: uA.id, conversationId: convB.id, idempotencyKey: 'shared-key', userMessage: 'segredo do B', plan: 'free', nowIso: NOW });
    } catch (e) { threw = true; status = httpStatusForError(e); }

    // INVARIANTE DE SEGURANÇA: A jamais obtém o turno de B (nem por replay, nem exposto em retorno).
    const aGotBsTurn = !threw && leaked && leaked.turn && leaked.turn.id === rB.turn.id;
    assert.strictEqual(aGotBsTurn, false, 'A NUNCA recebe o turno de B (anti-IDOR cross-tenant)');
    if (threw) assert.ok(status >= 400, `cross-tenant falha fechada (status=${status}), sem replay/vazamento`);
    // B intacto; A não criou turno nem consumiu cota
    const tB = await prisma.chatTurn.findUnique({ where: { id: rB.turn.id } });
    assert.strictEqual(tB.userId, uB.id, 'turno de B intacto e pertencente a B');
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: uA.id } }), 0, 'A não criou turno');
    assert.strictEqual(await H.usageCount(prisma, uA.id, DAY), 0, 'A não consumiu cota');
    assert.strictEqual(await H.usageCount(prisma, uB.id, DAY), 1, 'cota de B intacta');

    // SAME-USER continua funcionando: B replica a própria key/conteúdo → recebe o PRÓPRIO turno, sem 2º débito
    const rBreplay = await admitTurn(prisma, { userId: uB.id, conversationId: convB.id, idempotencyKey: 'shared-key', userMessage: 'segredo do B', plan: 'free', nowIso: NOW });
    assert.ok(['IN_FLIGHT', 'REPLAY'].includes(rBreplay.outcome), 'same-user replica normalmente');
    assert.strictEqual(rBreplay.turn.id, rB.turn.id, 'B recebe o próprio turno');
    assert.strictEqual(await H.usageCount(prisma, uB.id, DAY), 1, 'sem 2º débito no replay same-user');
  });
};
