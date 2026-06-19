'use strict';

// [FASE 5.1] Seletor do provider LLM. INFRAESTRUTURA — ainda NÃO consumido pelo
// financialNarrator (a ativação do seam é a FASE 5.2).
//
// Retorna o provider ATIVO conforme o ambiente, ou `null` (→ o narrator usa o
// determinístico). Contrato seguro:
//   LLM_PROVIDER ausente | 'deterministic'        → null (DEFAULT; comportamento atual)
//   LLM_PROVIDER 'anthropic' | 'claude' | 'llm'   → anthropicProvider, SE isAvailable()
//
// Mesmo selecionando um alias de LLM, sem ANTHROPIC_API_KEY o isAvailable() é false
// → retorna null → determinístico. Logo, nenhum comportamento muda sem configuração
// EXPLÍCITA (provider + chave) e nenhuma chamada externa ocorre sem chave.

const anthropicProvider = require('./anthropicProvider');

const LLM_ALIASES = new Set(['anthropic', 'claude', 'llm']);

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{isAvailable:Function, narrate:Function} | null}
 */
function getLlmProvider(env = process.env) {
  const sel = String((env && env.LLM_PROVIDER) || 'deterministic').toLowerCase();
  if (!LLM_ALIASES.has(sel)) return null;            // default determinístico
  if (!anthropicProvider.isAvailable()) return null; // sem chave → determinístico
  return anthropicProvider;
}

module.exports = { getLlmProvider };
