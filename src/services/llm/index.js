'use strict';

// [FASE 5.2] Seletor do provider LLM — agora CONSUMIDO pelo financialNarrator (seam ativo).
//
// Retorna o provider ATIVO, ou `null` (→ o narrator usa o determinístico). Gates em série:
//   1. LLM_PROVIDER ∈ {anthropic|claude|llm}       (senão → null; default determinístico)
//   2. ANTHROPIC_API_KEY presente (isAvailable())   (senão → null; nenhuma chamada externa)
//   3. CANÁRIO: userId ∈ LLM_CANARY_USER_IDS        (senão → null; NUNCA todos os PRO)
// Allowlist VAZIA ⇒ null para todos. Qualquer gate reprovado ⇒ determinístico.

const anthropicProvider = require('./anthropicProvider');

const LLM_ALIASES = new Set(['anthropic', 'claude', 'llm']);

function parseIds(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {string|number|null} [userId]  exigido pelo gate de canário
 * @returns {{isAvailable:Function, narrate:Function} | null}
 */
function getLlmProvider(env = process.env, userId = null) {
  const sel = String((env && env.LLM_PROVIDER) || 'deterministic').toLowerCase();
  if (!LLM_ALIASES.has(sel)) return null;            // 1. provider não selecionado
  if (!anthropicProvider.isAvailable()) return null; // 2. sem chave → sem chamada externa
  const allow = parseIds(env && env.LLM_CANARY_USER_IDS);
  if (allow.length === 0) return null;               // 3a. allowlist vazia → ninguém usa LLM
  if (userId == null || !allow.includes(String(userId))) return null; // 3b. fora da allowlist
  return anthropicProvider;
}

module.exports = { getLlmProvider };
