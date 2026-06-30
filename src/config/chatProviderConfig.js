'use strict';

// [Consultor · 1D] Gate ÚNICO de ativação do provider de chat (D1D-4) + knobs (D1D-2).
// Espelha o padrão da FASE 5.2 SEM tocar getLlmProvider. buildChatProvider E buildToolExecutor
// usam a MESMA função (fonte única — evita divergência provider×executor, R-D1D2-GATE).
// Sem ENV → desabilitado → seams retornam null → rota 503 (dormência preservada).

const anthropicProvider = require('../services/llm/anthropicProvider'); // read-only: isAvailable() (FASE 5 intocada)

const CHAT_PROVIDERS = new Set(['anthropic', 'claude', 'llm']);
const DEFAULT_MODEL = 'claude-opus-4-8';   // D1D-2: documentação oficial Anthropic (modelo padrão)
const DEFAULT_MAX_TOKENS = 4096;           // generoso p/ chat, não-streaming-safe (< 16K)

function parseIds(csv) {
  if (!csv || typeof csv !== 'string') return new Set();
  return new Set(csv.split(',').map((s) => s.trim()).filter(Boolean));
}

// Gate em série (todos verdadeiros): provider selecionado ∈ {anthropic,claude,llm}; ANTHROPIC_API_KEY
// presente (via isAvailable, read-only); userId no canário. Allowlist vazia ⇒ ninguém.
function isChatProviderEnabled(env = process.env, userId = null) {
  const sel = String(env.AI_CHAT_PROVIDER || '').toLowerCase();
  if (!CHAT_PROVIDERS.has(sel)) return false;
  if (!anthropicProvider.isAvailable()) return false; // lê ANTHROPIC_API_KEY (compartilhada, D1D-2)
  const canary = parseIds(env.AI_CHAT_CANARY_USER_IDS);
  if (canary.size === 0) return false;
  return userId != null && canary.has(String(userId));
}

// Descritor de boot SEM segredos (D1D-8): nunca expõe a API key nem os ids do canário, só flags/contagem.
// Reusa as MESMAS verificações do gate (provider válido + key presente + canário) — fonte única.
function describeGate(env = process.env) {
  const provider = String(env.AI_CHAT_PROVIDER || '').toLowerCase() || null;
  const providerValid = provider != null && CHAT_PROVIDERS.has(provider);
  const hasApiKey = anthropicProvider.isAvailable();
  const canaryCount = parseIds(env.AI_CHAT_CANARY_USER_IDS).size;
  return { provider, providerValid, hasApiKey, canaryCount, armed: providerValid && hasApiKey && canaryCount > 0 };
}

function chatModel(env = process.env) {
  const m = env.AI_CHAT_MODEL;
  return (typeof m === 'string' && m.trim() !== '') ? m.trim() : DEFAULT_MODEL;
}
function chatMaxTokens(env = process.env) {
  const n = Number.parseInt(env.AI_CHAT_MAX_TOKENS, 10);
  return (Number.isInteger(n) && n > 0) ? n : DEFAULT_MAX_TOKENS;
}

module.exports = { isChatProviderEnabled, describeGate, chatModel, chatMaxTokens, parseIds, DEFAULT_MODEL, DEFAULT_MAX_TOKENS, CHAT_PROVIDERS };
