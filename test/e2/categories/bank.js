'use strict';

// [Consultor · E2] Categoria 6 — Banco (transações + códigos de erro).
// T1 admissão · T2 refund · T3 reconciliação. COMMIT/ROLLBACK/RETRY, P2002, 40001, 40P01, 23514.
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
const admit = (prisma, u, c, key, msg, nowIso = NOW, plan = 'free') =>
  admitTurn(prisma, { userId: u, conversationId: c, idempotencyKey: key, userMessage: msg, plan, nowIso });

module.exports = (ctx) => {
  test('BANK-ADM-COMMIT-01 · admissão na cota → COMMIT, count=1, turno persiste', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    assert.strictEqual(r.outcome, 'ADMITTED'); assert.strictEqual(r.httpStatus, 201);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 1);
    assert.strictEqual(await prisma.chatMessage.count({ where: { userId: u.id } }), 1, 'mensagem do usuário persiste');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('BANK-ADM-429-ROLLBACK-02 · cota estourada → ROLLBACK, 429, sem turno extra', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    for (let i = 0; i < 5; i++) await admit(prisma, u.id, conv.id, 'k' + i, 'm' + i);
    const over = await admit(prisma, u.id, conv.id, 'k5', 'm5');
    assert.strictEqual(over.outcome, 'LIMIT'); assert.strictEqual(over.httpStatus, 429);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 5);
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 5, 'rollback total da 6ª');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('BANK-ADM-DB503-ROLLBACK-03 · falha de DB não-retryável → ROLLBACK → 503', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    await assert.rejects(
      () => admitTurn(prisma,
        { userId: u.id, conversationId: conv.id, idempotencyKey: 'k', userMessage: 'm', plan: 'free', nowIso: NOW },
        { afterLock: async () => { throw new Error('db down'); } }),
      (e) => { assert.strictEqual(httpStatusForError(e), 503); return true; },
    );
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 0);
  });

  test('BANK-ADM-CHECK-VIOLATION-ROLLBACK-04 · INSERT ADMITTED+billedAt → 23514, ROLLBACK', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    await assert.rejects(
      () => prisma.$executeRaw`
        INSERT INTO "ChatTurn" (id,"conversationId","userId",seq,"requestHash",state,"dayKey","billedAt","messageCount","createdAt","updatedAt")
        VALUES ('bad_chk', ${conv.id}, ${u.id}, 1, 'fmqh1:x', 'ADMITTED', ${DAY}, now(), 0, now(), now())`,
      (e) => {
        const code = (e.meta && String(e.meta.code)) || '';
        assert.ok(code === '23514' || /billed_consistency|23514/.test(e.message));
        return true;
      },
    );
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 0, 'nenhuma linha inserida');
  });

  test('BANK-REFUND-COMMIT-05 · refund → COMMIT, count-1', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await refundTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('BANK-BILLED-COMMIT-08 · DISPATCHING→BILLED → COMMIT, assistant write-once, cota retida', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    const b = await billTurn(prisma, { turnId: r.turn.id, userId: u.id, assistantContent: 'resp', nowIso: NOW });
    assert.strictEqual(b.billed, true);
    const msgs = await prisma.chatMessage.findMany({ where: { turnId: r.turn.id }, orderBy: { seq: 'asc' } });
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[1].role, 'assistant');
    assert.strictEqual(msgs[1].assistantMessageSeq, 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('BANK-IDEMP-CONFLICT-409-12 · mesma key, requestHash diferente → 409', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    await admit(prisma, u.id, conv.id, 'k', 'A');
    const c = await admit(prisma, u.id, conv.id, 'k', 'B');
    assert.strictEqual(c.outcome, 'CONFLICT'); assert.strictEqual(c.httpStatus, 409);
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
  });

  test('BANK-REPLAY-INFLIGHT-202-13 · replay de turno DISPATCHING → 202', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
    const again = await admit(prisma, u.id, conv.id, 'k', 'm');
    assert.strictEqual(again.outcome, 'IN_FLIGHT'); assert.strictEqual(again.httpStatus, 202);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
  });

  test('BANK-SERIALIZATION-40001-RETRY-14 · 40001 transitório → retry → COMMIT', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    let attempts = 0; let retries = 0;
    const r = await admitTurn(prisma,
      { userId: u.id, conversationId: conv.id, idempotencyKey: 'k', userMessage: 'm', plan: 'free', nowIso: NOW },
      { afterLock: async () => { attempts += 1; if (attempts <= 2) throw H.pgError('40001'); }, onRetry: () => { retries += 1; } });
    assert.strictEqual(r.outcome, 'ADMITTED');
    assert.strictEqual(retries, 2, '2 retries antes do sucesso');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1, 'exatamente 1 admissão apesar dos retries');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('BANK-SERIALIZATION-40001-EXHAUST-503 · 40001 persistente → esgota retries → 503 (D4)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    let retries = 0;
    await assert.rejects(
      () => admitTurn(prisma,
        { userId: u.id, conversationId: conv.id, idempotencyKey: 'k', userMessage: 'm', plan: 'free', nowIso: NOW },
        { afterLock: async () => { throw H.pgError('40001'); }, onRetry: () => { retries += 1; } }),
      (e) => { assert.strictEqual(httpStatusForError(e), 503); return true; },
    );
    assert.ok(retries >= 5, `esgotou os retries (viu ${retries})`);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 0);
  });

  test('BANK-DEADLOCK-40P01-AVOIDED-15 · admissão adquire o advisory lock (spy direto, R18)', async () => {
    const { prisma, capture } = ctx; const { u, conv } = await setup(ctx);
    capture.start();
    await admit(prisma, u.id, conv.id, 'k', 'm');
    capture.stop();
    assert.ok(capture.advisoryLocks() >= 1, 'admissão adquire pg_advisory_xact_lock (lock-ordering anti-40P01)');
  });

  test('BANK-DEADLOCK-40P01-INJECTED-RETRY-16 · 40P01 injetado → retryável → COMMIT', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    let attempts = 0; let retries = 0;
    const r = await admitTurn(prisma,
      { userId: u.id, conversationId: conv.id, idempotencyKey: 'k', userMessage: 'm', plan: 'free', nowIso: NOW },
      { afterLock: async () => { attempts += 1; if (attempts === 1) throw H.pgError('40P01'); }, onRetry: () => { retries += 1; } });
    assert.strictEqual(r.outcome, 'ADMITTED');
    assert.strictEqual(retries, 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
  });

  test('BANK-RECONCILE-STALE-DRIFT-ZERO-17 · reconciliação de stale → S→0', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r = await admit(prisma, u.id, conv.id, 'k', 'm');
    await H.backdateTurn(prisma, r.turn.id, { updatedAtSecAgo: H.TTL + 60 });
    const { reconcileUserLazy } = require('../../../src/services/chat/chatReconciliationService');
    await reconcileUserLazy(prisma, { userId: u.id });
    const x = await H.assertDriftZero(assert, prisma, u.id, DAY, null);
    assert.strictEqual(x.s, 0);
  });

  test('BANK-CRASH-MIDTX-NO-PARTIAL-18 · falha pré-commit (entre INSERT turn e message) → sem efeito parcial (R20)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    // (pré-commit) falha entre INSERT turn e INSERT message → NADA persiste, count=0
    await assert.rejects(() => admitTurn(prisma,
      { userId: u.id, conversationId: conv.id, idempotencyKey: 'k', userMessage: 'm', plan: 'free', nowIso: NOW },
      { afterTurn: async () => { throw new Error('crash mid-tx'); } }));
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 0, 'pré-commit: turno não existe');
    assert.strictEqual(await prisma.chatMessage.count({ where: { userId: u.id } }), 0);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, 'pré-commit: count=0');
    // (pós-commit) admissão limpa: turno existe, count=1
    const ok = await admit(prisma, u.id, conv.id, 'k', 'm');
    assert.strictEqual(ok.outcome, 'ADMITTED');
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 1, 'pós-commit: turno existe');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1, 'pós-commit: count=1');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('BANK-DEDUPE-UNDER-LOCK-09/10/11 · same-key concorrente serializado pelo lock → DEDUPE (não 23505), 1 admissão, 0 5xx', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    // COBERTURA HONESTA (auditoria E2.1): o advisory lock por-usuário serializa as 20 admissões.
    // Cada perdedora, ao adquirir o lock APÓS o commit da vencedora, encontra o turno no
    // dedupe-SELECT (passo 2) e retorna replay ANTES do INSERT — portanto o caminho 23505→re-lookup
    // do admitTurn NÃO é exercido aqui. Esse branch defensivo é coberto separadamente, e de forma
    // genuína, por BANK-23505-RELOOKUP-DEFENSIVE (abaixo). Aqui provamos a resolução por DEDUPE.
    const res = await H.makeBarrier().run(20, () => admit(prisma, u.id, conv.id, 'SAME', 'igual'));
    const admitted = res.filter((x) => x.status === 'fulfilled' && x.value.outcome === 'ADMITTED').length;
    const rejected = res.filter((x) => x.status === 'rejected').length;
    const replays = res.filter((x) => x.status === 'fulfilled' && ['REPLAY', 'IN_FLIGHT'].includes(x.value.outcome)).length;
    assert.strictEqual(admitted, 1, 'exatamente 1 admissão');
    assert.strictEqual(replays, 19, '19 perdedoras resolvidas por dedupe (replay/in-flight)');
    assert.strictEqual(rejected, 0, 'nenhuma 5xx (lock + dedupe absorvem as duplicatas)');
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 1, 'unique + lock impedem duplicata');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('BANK-23505-RELOOKUP-DEFENSIVE · 23505 FORÇADO (corrida que o lock impede) → catch re-lookup → replay, sem 5xx (R17)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const { computeRequestHash } = require('../../../src/services/chat/requestHash');
    const msg = 'oi';
    const rivalHash = computeRequestHash(conv.id, msg); // mesmo conteúdo → mesmo requestHash → replay (não conflito)
    let fired = false;
    // O seam afterQuota roda APÓS o dedupe-SELECT (que errou) e ANTES do INSERT do turno.
    // Inserimos um turno RIVAL com a MESMA (conversationId, idempotencyKey) por uma conexão
    // SEPARADA do pool (sem adquirir o advisory lock) — simula um caminho hipotético NÃO-travado
    // que produziria a corrida que, em produção, o lock por-usuário fecha. O INSERT da admissão
    // então colide (P2002/23505) e cai no branch defensivo → re-lookup → replay determinístico.
    const r = await admitTurn(
      prisma,
      { userId: u.id, conversationId: conv.id, idempotencyKey: 'K', userMessage: msg, plan: 'free', nowIso: NOW },
      {
        afterQuota: async () => {
          if (fired) return; fired = true;
          await prisma.$executeRaw`
            INSERT INTO "ChatTurn" (id,"conversationId","userId",seq,"idempotencyKey","requestHash",state,"dayKey","messageCount","createdAt","updatedAt")
            VALUES ('rival_turn', ${conv.id}, ${u.id}, 1, 'K', ${rivalHash}, 'ADMITTED', ${DAY}, 1, now(), now())`;
        },
      },
    );
    assert.strictEqual(fired, true, 'o seam disparou — caminho 23505→re-lookup exercitado ≥1 (R17 satisfeito)');
    assert.ok(['REPLAY', 'IN_FLIGHT'].includes(r.outcome), `catch re-lookup serve o turno existente (got ${r.outcome}); nunca 5xx`);
    assert.strictEqual(r.turn.id, 'rival_turn', 're-lookup retornou exatamente o turno rival');
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 1, 'só o rival; a admissão deu rollback total (sem turno órfão)');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, 'CAS da admissão revertida no rollback; rival não passou pela CAS → count=0');
  });

  test('ADM-FAIL-BETWEEN-CAS-AND-INSERT · falha entre passo 4 (count+1) e 5 (INSERT) → 503, 0 cota fantasma (R3)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    await assert.rejects(
      () => admitTurn(prisma,
        { userId: u.id, conversationId: conv.id, idempotencyKey: 'k', userMessage: 'm', plan: 'free', nowIso: NOW },
        { afterQuota: async () => { throw new Error('falha entre CAS e INSERT'); } }),
      (e) => { assert.strictEqual(httpStatusForError(e), 503); return true; },
    );
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, 'count revertido — 0 cota fantasma');
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('RACE-DOUBLE-BILL-01 · 2× DISPATCHING→BILLED concorrente → 1 vence, assistant write-once (R9)', async () => {
    const { prisma } = ctx;
    for (let rep = 0; rep < 20; rep++) {
      await H.reset(prisma);
      const { u, conv } = await setup(ctx);
      const r = await admit(prisma, u.id, conv.id, 'k', 'm');
      await dispatchTurn(prisma, { turnId: r.turn.id, userId: u.id, nowIso: NOW });
      const res = await H.makeBarrier().run(2, () => billTurn(prisma, { turnId: r.turn.id, userId: u.id, assistantContent: 'r', nowIso: NOW }));
      const billed = res.filter((x) => x.status === 'fulfilled' && x.value.billed).length;
      assert.strictEqual(billed, 1, `rep ${rep}: exatamente 1 BILLED`);
      const assistants = await prisma.chatMessage.count({ where: { turnId: r.turn.id, role: 'assistant' } });
      assert.strictEqual(assistants, 1, 'assistant write-once');
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
      await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    }
  });

  test('SEQ-DERIVATION-UNDER-LOCK · lock ANTES do seq (spy) + 50 seqs contíguos (R12)', async () => {
    const { prisma, capture } = ctx;
    // (a) ordenação: o advisory lock é adquirido ANTES da derivação do seq
    {
      const { u, conv } = await setup(ctx, 'pro');
      capture.start();
      await admit(prisma, u.id, conv.id, 'k', 'm', NOW, 'pro');
      const q = capture.stop();
      const lockIdx = q.findIndex((s) => /pg_advisory_xact_lock/i.test(s));
      const seqIdx = q.findIndex((s) => /MAX\(seq\)/i.test(s) && /"ChatTurn"/i.test(s));
      assert.ok(lockIdx >= 0, 'advisory lock presente');
      assert.ok(seqIdx >= 0, 'derivação de seq presente');
      assert.ok(lockIdx < seqIdx, `lock (idx ${lockIdx}) ANTES do seq (idx ${seqIdx})`);
    }
    // (b) 50 admissões concorrentes (mesmo user/conversa) → seqs exatamente {1..50}, sem colisão/gap
    await H.reset(prisma);
    const { u, conv } = await setup(ctx, 'pro');
    await H.makeBarrier().run(50, (i) => admit(prisma, u.id, conv.id, 'k' + i, 'm' + i, NOW, 'pro'));
    const turns = await prisma.chatTurn.findMany({ where: { userId: u.id }, select: { seq: true }, orderBy: { seq: 'asc' } });
    assert.strictEqual(turns.length, 50);
    const seqs = turns.map((t) => t.seq);
    assert.deepStrictEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1), 'seqs contíguos {1..50}, derivados sob o lock');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });
};
