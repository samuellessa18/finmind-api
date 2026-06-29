'use strict';

// [Consultor · E2] Motor de cotas (chatQuotaGuard) — Baseline §§2–4, RFC0004.
//   "o motor calcula, a IA narra": este módulo NÃO chama provider; só estado + cota.
//
// Decisões oficiais do owner aplicadas:
//   D1 — refund/reconciliação também adquirem o advisory lock por-usuário.
//   D2 — idempotencyKey obrigatória (validação dura, espelha o Zod da rota).
//   D3 — o dayKey persistido no ChatTurn é a única fonte; nunca recalculado no refund.
//   D4 — 40001/40P01 esgotados → 503 (via withRetry + httpStatusForError).
//   D5 — (id,userId) tratado como não-colidível (CUID).

const config = require('../../config/chatConfig');
const { acquireUserXactLock } = require('../../lib/advisoryLock');
const { computeRequestHash } = require('./requestHash');
const { resolveNowContext, overrideDate } = require('./chatTime');
const { ChatValidationError, QuotaLimitError, OUTCOME, pgState, withRetry } = require('./chatErrors');

// Sob alta contenção (ex.: 500 admissões simultâneas do mesmo usuário), as transações
// serializam no advisory lock — a seção crítica é minúscula, então DEVEM esperar na fila,
// não estourar. Folga ampla em maxWait/timeout (o caso saudável resolve em ms).
const TX_OPTS = { maxWait: 30000, timeout: 30000 };

function limitForPlan(plan) {
  return plan === 'pro' ? config.quota.proDailyLimit : config.quota.freeDailyLimit;
}

function replayOutcome(turn, requestHash) {
  if (turn.requestHash !== requestHash) {
    return { outcome: OUTCOME.CONFLICT, httpStatus: config.replay.conflictHttpStatus, turn };
  }
  if (turn.state === 'ADMITTED' || turn.state === 'DISPATCHING') {
    return { outcome: OUTCOME.IN_FLIGHT, httpStatus: 202, turn };
  }
  return { outcome: OUTCOME.REPLAY, httpStatus: 200, turn };
}

// ─── ADMISSÃO (transação única) ──────────────────────────────────────────────
async function admitTurn(prisma, params, opts = {}) {
  const { userId, conversationId, idempotencyKey, userMessage, plan = 'free', nowIso = null } = params;

  // D2: validação dura.
  if (!userId || typeof userId !== 'string') throw new ChatValidationError('userId obrigatório');
  if (!conversationId || typeof conversationId !== 'string') throw new ChatValidationError('conversationId obrigatório');
  if (idempotencyKey == null || idempotencyKey === '') throw new ChatValidationError('idempotencyKey obrigatória (D2)');
  if (typeof userMessage !== 'string' || userMessage.length === 0) throw new ChatValidationError('userMessage obrigatório');

  const requestHash = computeRequestHash(conversationId, userMessage);
  const limit = limitForPlan(plan);

  return withRetry(async () => {
    try {
      return await prisma.$transaction(async (tx) => {
        await acquireUserXactLock(tx, userId);                  // D1 / Apêndice C
        if (opts.afterLock) await opts.afterLock(tx);           // seam de injeção de falha (testes)
        const { dayKey } = await resolveNowContext(tx, nowIso); // D3 — dayKey server-derived

        // (2) dedupe por (conversationId, idempotencyKey)
        const existing = await tx.chatTurn.findUnique({
          where: { conversationId_idempotencyKey: { conversationId, idempotencyKey } },
        });
        if (existing) return replayOutcome(existing, requestHash);

        // (3) garante a linha de cota (não incrementa)
        await tx.chatUsage.upsert({
          where: { userId_dayKey: { userId, dayKey } },
          create: { userId, dayKey, count: 0 },
          update: {},
        });

        // (4) CAS de cota: count+1 WHERE count<limit
        const inc = await tx.$executeRaw`
          UPDATE "ChatUsage" SET count = count + 1, "updatedAt" = now()
          WHERE "userId" = ${userId} AND "dayKey" = ${dayKey} AND count < ${limit}`;
        if (inc === 0) throw new QuotaLimitError();             // → rollback total → 429

        if (opts.afterQuota) await opts.afterQuota(tx);         // seam: falha ENTRE CAS e INSERT (R3)

        // (5) seq por conversa, DERIVADO sob o advisory lock (R12)
        const seqRows = await tx.$queryRaw`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM "ChatTurn" WHERE "conversationId" = ${conversationId}`;
        const seq = Number(seqRows[0].next);

        const turn = await tx.chatTurn.create({
          data: { conversationId, userId, seq, idempotencyKey, requestHash, state: 'ADMITTED', dayKey, messageCount: 1 },
        });

        if (opts.afterTurn) await opts.afterTurn(tx);           // seam: falha ENTRE INSERT turn e INSERT message (R3)

        // (6) mensagem do usuário
        await tx.chatMessage.create({
          data: { turnId: turn.id, conversationId, userId, seq: 1, role: 'user', content: userMessage },
        });

        return { outcome: OUTCOME.ADMITTED, httpStatus: 201, turn };
      }, TX_OPTS);
    } catch (e) {
      if (e instanceof QuotaLimitError) return { outcome: OUTCOME.LIMIT, httpStatus: 429 };
      if (pgState(e) === '23505') {
        // P2002: corrida no unique (idempotencyKey/seq) → re-lookup determinístico
        const again = await prisma.chatTurn.findUnique({
          where: { conversationId_idempotencyKey: { conversationId, idempotencyKey } },
        });
        if (again) return replayOutcome(again, requestHash);
      }
      throw e; // 40001/40P01 → withRetry; demais → 503 no chamador
    }
  }, { onRetry: opts.onRetry });
}

// ─── ADMITTED → DISPATCHING ───────────────────────────────────────────────────
async function dispatchTurn(prisma, { turnId, userId, nowIso = null }) {
  const now = overrideDate(nowIso);
  return withRetry(() => prisma.$transaction(async (tx) => {
    await acquireUserXactLock(tx, userId); // D1
    const rows = await tx.$executeRaw`
      UPDATE "ChatTurn"
         SET state = 'DISPATCHING',
             "providerCallStartedAt" = COALESCE(${now}::timestamptz, now()),
             "updatedAt" = now()
       WHERE id = ${turnId} AND "userId" = ${userId} AND state = 'ADMITTED'`;
    return { dispatched: rows === 1, casRows: rows };
  }, TX_OPTS));
}

// ─── DISPATCHING → BILLED (cota cobrada, NÃO devolvida) ────────────────────────
async function billTurn(prisma, { turnId, userId, assistantContent = '', stopReason = 'end_turn', usage = {}, nowIso = null }, opts = {}) {
  const now = overrideDate(nowIso);
  return withRetry(() => prisma.$transaction(async (tx) => {
    await acquireUserXactLock(tx, userId); // D1
    if (opts.afterLock) await opts.afterLock(tx);
    const rows = await tx.$executeRaw`
      UPDATE "ChatTurn"
         SET state = 'BILLED',
             "billedAt" = COALESCE(${now}::timestamptz, now()),
             "stopReason" = ${stopReason},
             "usageInputTokens" = ${usage.input ?? null},
             "usageOutputTokens" = ${usage.output ?? null},
             "messageCount" = "messageCount" + 1,
             "updatedAt" = now()
       WHERE id = ${turnId} AND "userId" = ${userId} AND state = 'DISPATCHING'`;
    if (rows !== 1) return { billed: false, casRows: rows };

    const turn = await tx.chatTurn.findUnique({ where: { id: turnId } });
    const seqRows = await tx.$queryRaw`SELECT COALESCE(MAX(seq),0)+1 AS next FROM "ChatMessage" WHERE "turnId" = ${turnId}`;
    const amsRows = await tx.$queryRaw`SELECT COALESCE(MAX("assistantMessageSeq"),0)+1 AS next FROM "ChatMessage" WHERE "conversationId" = ${turn.conversationId}`;
    await tx.chatMessage.create({
      data: {
        turnId, conversationId: turn.conversationId, userId,
        seq: Number(seqRows[0].next), role: 'assistant',
        content: assistantContent, assistantMessageSeq: Number(amsRows[0].next),
      },
    });
    return { billed: true, casRows: rows };
  }, TX_OPTS));
}

// ─── REFUND (regra única) — usado por refundTurn e pela reconciliação ─────────
// CAS de estado + decremento condicionado a rows-affected=1, na MESMA tx, no dayKey
// PERSISTIDO (D3). Idempotente: CAS=0 ⇒ no-op (sem dupla devolução).
async function _refundOnTx(tx, { turnId, userId, dayKey, terminal, now }) {
  const cas = await tx.$executeRaw`
    UPDATE "ChatTurn"
       SET state = ${terminal},
           "refundedAt" = COALESCE(${now}::timestamptz, now()),
           "updatedAt" = now()
     WHERE id = ${turnId} AND "userId" = ${userId}
       AND state IN ('ADMITTED', 'DISPATCHING') AND "billedAt" IS NULL`;
  if (cas === 0) return { casRows: 0, decremented: false };
  const dec = await tx.$executeRaw`
    UPDATE "ChatUsage" SET count = count - 1, "updatedAt" = now()
     WHERE "userId" = ${userId} AND "dayKey" = ${dayKey} AND count > 0`;
  return { casRows: cas, decremented: dec === 1 };
}

async function refundTurn(prisma, { turnId, userId, terminal = 'REFUNDED', nowIso = null }, opts = {}) {
  if (terminal !== 'REFUNDED' && terminal !== 'ERROR') throw new ChatValidationError('terminal deve ser REFUNDED|ERROR');
  const now = overrideDate(nowIso);
  return withRetry(() => prisma.$transaction(async (tx) => {
    await acquireUserXactLock(tx, userId); // D1
    if (opts.afterLock) await opts.afterLock(tx);
    const turn = await tx.chatTurn.findFirst({ where: { id: turnId, userId } });
    if (!turn) return { outcome: 'NOT_FOUND', decremented: false, casRows: 0 };
    const r = await _refundOnTx(tx, { turnId, userId, dayKey: turn.dayKey, terminal, now }); // D3: turn.dayKey persistido
    return { outcome: r.casRows ? terminal : 'NOOP_REFUND', decremented: r.decremented, casRows: r.casRows };
  }, TX_OPTS), { onRetry: opts.onRetry });
}

module.exports = {
  admitTurn, dispatchTurn, billTurn, refundTurn,
  _refundOnTx, limitForPlan, replayOutcome, TX_OPTS,
};
