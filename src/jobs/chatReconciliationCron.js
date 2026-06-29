'use strict';

// [Consultor · 1C] Cron de reconciliação RESILIENTE (D1C-9 / R1C-3).
//   O loop CONGELADO de reconcileCron (chatReconciliationService L59-62) NÃO tem try/catch por usuário:
//   um throw persistente de UM usuário abortaria o lote inteiro. Como a E2 está congelada, a isolação
//   POR-USUÁRIO vive AQUI: listamos os usuários em voo e chamamos reconcileUserLazy por usuário, cada um
//   num try/catch próprio. Um usuário "venenoso" NUNCA interrompe o processamento do lote.
//
//   Reusa o primitivo congelado reconcileUserLazy (a regra de refund continua sendo só do motor E2).
//   Idempotente (CAS); cap NÃO-silencioso (truncated → alerta de backlog, C8-CRON-CAP).

const { reconcileUserLazy } = require('../services/chat/chatReconciliationService');

async function runChatReconciliationCron(prisma, opts = {}) {
  const { nowIso = null, batchSize = 200, logger = console, metrics = null, reconcileFn = reconcileUserLazy } = opts;

  let users;
  try {
    users = await prisma.$queryRaw`
      SELECT DISTINCT "userId" FROM "ChatTurn"
       WHERE state IN ('ADMITTED','DISPATCHING')
       LIMIT ${batchSize}`;
  } catch (e) {
    if (logger && logger.error) logger.error('[chatReconcileCron] falha ao listar usuários:', e && e.message);
    return { usersScanned: 0, refunded: 0, failedUsers: 0, truncated: false, listError: true };
  }

  let refunded = 0;
  let failedUsers = 0;
  for (const u of users) {
    try {
      const r = await reconcileFn(prisma, { userId: u.userId, nowIso });
      refunded += r.refunded;
      if (metrics) for (let i = 0; i < r.refunded; i++) metrics.inc('refund_total');
    } catch (e) {
      // ISOLAÇÃO POR-USUÁRIO (D1C-9): captura e segue; o erro NÃO é engolido em silêncio (loga),
      // mas NÃO aborta os demais usuários do lote.
      failedUsers += 1;
      if (logger && logger.error) logger.error('[chatReconcileCron] usuário', u.userId, 'falhou:', e && e.message);
    }
  }

  const truncated = users.length === batchSize; // backlog possível — não-silencioso (C8-CRON-CAP)
  if (truncated && logger && logger.warn) {
    logger.warn('[chatReconcileCron] lote no limite (batchSize=' + batchSize + ') — possível backlog de reconciliação');
  }
  return { usersScanned: users.length, refunded, failedUsers, truncated };
}

module.exports = { runChatReconciliationCron };
