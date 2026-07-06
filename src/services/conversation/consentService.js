'use strict';

// [Consultor · G1] Writers de consent ai_chat (grant/revoke). consentGate.js permanece READ-ONLY
// (contrato congelado: hasChatConsent). Scope vem da fonte única AI_CHAT_SCOPE. Escopo SEMPRE por
// userId autenticado (nunca body). Sem @@unique no schema → grant usa find-guard-then-create;
// revoke usa updateMany (fecha TODAS as linhas ativas, cobrindo duplicatas).

const { AI_CHAT_SCOPE } = require('./consentGate'); // read-only import da fonte única do scope

// Grant idempotente: se já existe linha ativa (revokedAt=null), retorna-a; senão cria uma nova.
// Invariante pós-grant: exatamente >=1 linha ativa (grant→revoke→grant reabre o gate).
async function grantChatConsent(prisma, userId) {
  if (!userId) throw new Error('grantChatConsent: userId obrigatório');
  const existing = await prisma.userConsent.findFirst({
    where: { userId, scope: AI_CHAT_SCOPE, revokedAt: null },
    select: { id: true },
  });
  if (existing) return { granted: true, created: false, id: existing.id };
  const row = await prisma.userConsent.create({
    data: { userId, scope: AI_CHAT_SCOPE, grantedAt: new Date(), revokedAt: null },
    select: { id: true },
  });
  return { granted: true, created: true, id: row.id };
}

// Revoke idempotente: fecha TODAS as linhas ativas do usuário (updateMany), cobrindo duplicatas.
// Revogar sem consent ativo → count=0 → no-op idempotente (200 mesmo assim).
async function revokeChatConsent(prisma, userId) {
  if (!userId) throw new Error('revokeChatConsent: userId obrigatório');
  const r = await prisma.userConsent.updateMany({
    where: { userId, scope: AI_CHAT_SCOPE, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { revoked: true, count: r.count };
}

module.exports = { grantChatConsent, revokeChatConsent };
