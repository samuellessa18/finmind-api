'use strict';

// [Consultor · 1D] Seams do provider de chat — ATIVADOS por env (gate único, FASE 1D).
// Gate dormente/gated por LGPD (D1D-10): sem AI_CHAT_PROVIDER+ANTHROPIC_API_KEY+canário, ambos
// retornam null → a rota responde 503 chat_unavailable SEM consumir cota. NENHUMA chamada externa
// sem configuração explícita. buildChatProvider e buildToolExecutor usam a MESMA função de gate
// (isChatProviderEnabled) — provider e executor nunca divergem (R-D1D2-GATE).
//
// O adapter run() é NOVO (anthropicChatAdapter, sobre messages.create COM tools) — não toca a FASE 5.

const { isChatProviderEnabled } = require('../../config/chatProviderConfig');
const { createChatProvider } = require('./anthropicChatAdapter');
const { makeToolExecutor } = require('./tools/financialTools');

function buildChatProvider(user) {
  if (!isChatProviderEnabled(process.env, user && user.id)) return null; // dormente
  return createChatProvider();
}

function buildToolExecutor(user) {
  if (!isChatProviderEnabled(process.env, user && user.id)) return null; // mesmo gate que o provider
  return makeToolExecutor(user && user.id);
}

module.exports = { buildChatProvider, buildToolExecutor };
