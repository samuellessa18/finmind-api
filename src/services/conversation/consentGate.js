'use strict';

// [Consultor · 1C] Consent gate LGPD (D1C-7) — valida ANTES do guard; sem consent ai_chat → 403.
//   Regra exata (R1C-12): EXISTS(UserConsent WHERE userId AND scope='ai_chat' AND revokedAt IS NULL).
//   Ordem-independente (grant→revoke→grant): basta ≥1 linha ativa. Escopado pelo userId autenticado,
//   NUNCA pelo body. Corpo do 403 é único `consent_required` (não distingue ausente de revogado no wire).

const AI_CHAT_SCOPE = 'ai_chat';

async function hasChatConsent(prisma, userId) {
  if (!userId) return false;
  const row = await prisma.userConsent.findFirst({
    where: { userId, scope: AI_CHAT_SCOPE, revokedAt: null },
    select: { id: true },
  });
  return row !== null;
}

// Middleware Express: usa req.user.id (autenticado). Não muta getLlmProvider (gating é independente).
function requireConsentGate(prisma) {
  return async function consentGate(req, res, next) {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ error: 'unauthenticated' });
      if (await hasChatConsent(prisma, userId)) return next();
      return res.status(403).json({ error: 'consent_required' });
    } catch (e) {
      return next(e);
    }
  };
}

module.exports = { hasChatConsent, requireConsentGate, AI_CHAT_SCOPE };
