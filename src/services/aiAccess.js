'use strict';

// [FASE 3.4] Helper puro de acesso a features de IA.
// Espelha a regra do mobile (mobile/src/utils/aiAccess.js) com tolerância
// extra: backend aceita plan='pro' (schema atual) e plan='premium' (legado/
// nome alternativo) — defesa em profundidade contra divergências de nomenclatura.

function isPremiumUser(user) {
  if (!user) return false;
  return Boolean(user.isPremium || user.plan === 'pro' || user.plan === 'premium');
}

function hasActiveTemporaryAI(user, now = new Date()) {
  if (!user?.aiUnlockedUntil) return false;
  const expiry = user.aiUnlockedUntil instanceof Date
    ? user.aiUnlockedUntil
    : new Date(user.aiUnlockedUntil);
  return expiry > now;
}

/**
 * Verifica se o usuário tem acesso a features de IA AGORA.
 * Premium permanente OU unlock temporário ativo.
 */
function canUseAI(user, now = new Date()) {
  return isPremiumUser(user) || hasActiveTemporaryAI(user, now);
}

module.exports = { isPremiumUser, hasActiveTemporaryAI, canUseAI };
