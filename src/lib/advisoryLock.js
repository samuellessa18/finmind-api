'use strict';

// [Consultor Financeiro IA · Pré-fase] Advisory lock por usuário (64-bit).
// Fonte: docs/architecture/consultor-financeiro-ia/baseline-v1.2.md (§6 / Apêndice C, RFC0004).
//
// Serializa, por usuário, os fluxos que competem na mesma chave (erasure × admissão ×
// reconciliação) — evita o deadlock 40P01 (RFC0003 §1.1) e a corrida E4×E2 (Baseline §9).
//
// Contrato IMUTÁVEL (Apêndice C):
//  - chave de 64 bits via hashtextextended(userId, 0)  [bigint real]
//  - PROIBIDO hashtext()::bigint (32-bit) — colisão ~certa a 1e5 usuários (RFC0003 §6.4)
//  - pg_advisory_xact_lock é liberado AUTOMATICAMENTE no commit/rollback da tx
//  - DEVE ser chamado DENTRO de uma transação Prisma interativa (`prisma.$transaction(async (tx) => …)`)

/**
 * Adquire o advisory lock transacional do usuário. Bloqueia até obter; libera no fim da tx.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx - cliente transacional Prisma
 * @param {string} userId - id (cuid) do titular; nunca derivado do cliente
 */
async function acquireUserXactLock(tx, userId) {
  if (!tx || typeof tx.$executeRaw !== 'function') {
    throw new Error('[advisoryLock] tx inválido: chame DENTRO de prisma.$transaction((tx) => …)');
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error('[advisoryLock] userId (string) obrigatório');
  }
  // $executeRaw com template tag → ${userId} é PARAMETRIZADO (sem SQL injection).
  // hashtextextended(text, int8) → int8 (64-bit); pg_advisory_xact_lock(int8).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;
}

module.exports = { acquireUserXactLock };
