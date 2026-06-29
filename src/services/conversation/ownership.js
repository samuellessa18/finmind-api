'use strict';

// [Consultor · 1C] Posse de conversa (D1C-4) — 1ª barreira anti-IDOR, ANTES do guard.
// Conversa pertence SEMPRE ao usuário autenticado. Consulta SEMPRE escopada por (id, userId)
// (aproveita @@unique([id,userId])). Recurso que não pertence ao usuário → tratado como 404
// (unificado: não distingue "de outro tenant" de "inexistente" → não vaza existência).

async function findOwnedConversation(prisma, { conversationId, userId }) {
  if (!conversationId || !userId) return null;
  return prisma.chatConversation.findFirst({
    where: { id: conversationId, userId }, // escopo de tenant: nunca lê conversa alheia
    select: { id: true, userId: true, archivedAt: true },
  });
}

module.exports = { findOwnedConversation };
