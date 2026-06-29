'use strict';

// [Consultor · E2] Reconciliação (lazy + cron) — Baseline §4.
//   Turnos estagnados (termo S do drift) são levados a terminal refundante, liberando
//   a cota. Tudo sob o advisory lock por-usuário (D1). Idempotente via rows-affected do CAS.
//   ADMITTED stale (idade > TTL_STALE_ADMITTED) → REFUNDED.
//   DISPATCHING stale (fora da janela LLM_TIMEOUT_MS) → ERROR (terminal refundante).

const config = require('../../config/chatConfig');
const { acquireUserXactLock } = require('../../lib/advisoryLock');
const { overrideDate } = require('./chatTime');
const { withRetry } = require('./chatErrors');
const { _refundOnTx, TX_OPTS } = require('./chatQuotaService');

const TTL = config.turn.ttlStaleAdmittedSeconds;
const LLM_SEC = Math.ceil(config.turn.llmTimeoutMs / 1000);

// Seleciona os turnos stale de um usuário, ancorando a janela no `now` (override de teste
// ou now() do Postgres). Usa o índice parcial ChatTurn_reconciliation_idx.
async function _findStaleForUser(tx, userId, now) {
  if (now) {
    return tx.$queryRaw`
      SELECT id, state, "dayKey" FROM "ChatTurn"
       WHERE "userId" = ${userId} AND state IN ('ADMITTED','DISPATCHING') AND "billedAt" IS NULL
         AND ( (state = 'ADMITTED'    AND "updatedAt" < ${now}::timestamptz - make_interval(secs => ${TTL}))
            OR (state = 'DISPATCHING' AND COALESCE("providerCallStartedAt","updatedAt") < ${now}::timestamptz - make_interval(secs => ${LLM_SEC})) )`;
  }
  return tx.$queryRaw`
    SELECT id, state, "dayKey" FROM "ChatTurn"
     WHERE "userId" = ${userId} AND state IN ('ADMITTED','DISPATCHING') AND "billedAt" IS NULL
       AND ( (state = 'ADMITTED'    AND "updatedAt" < now() - make_interval(secs => ${TTL}))
          OR (state = 'DISPATCHING' AND COALESCE("providerCallStartedAt","updatedAt") < now() - make_interval(secs => ${LLM_SEC})) )`;
}

/** Reconciliação LAZY: resolve os stale de UM usuário (próxima requisição dele). */
async function reconcileUserLazy(prisma, { userId, nowIso = null }, opts = {}) {
  const now = overrideDate(nowIso);
  return withRetry(() => prisma.$transaction(async (tx) => {
    await acquireUserXactLock(tx, userId); // D1
    if (opts.afterLock) await opts.afterLock(tx);
    const stale = await _findStaleForUser(tx, userId, now);
    let refunded = 0;
    for (const t of stale) {
      const terminal = t.state === 'DISPATCHING' ? 'ERROR' : 'REFUNDED';
      const r = await _refundOnTx(tx, { turnId: t.id, userId, dayKey: t.dayKey, terminal, now });
      if (r.casRows) refunded += 1;
    }
    return { scanned: stale.length, refunded };
  }, TX_OPTS), { onRetry: opts.onRetry });
}

/** Reconciliação CRON: varre o índice parcial e reconcilia por usuário (cada um sob seu lock). */
async function reconcileCron(prisma, { nowIso = null, batchSize = 200 } = {}) {
  const users = await prisma.$queryRaw`
    SELECT DISTINCT "userId" FROM "ChatTurn"
     WHERE state IN ('ADMITTED','DISPATCHING')
     LIMIT ${batchSize}`;
  let refunded = 0;
  for (const u of users) {
    const r = await reconcileUserLazy(prisma, { userId: u.userId, nowIso });
    refunded += r.refunded;
  }
  return { usersScanned: users.length, refunded };
}

module.exports = { reconcileUserLazy, reconcileCron, _findStaleForUser, TTL, LLM_SEC };
