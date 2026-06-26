'use strict';

// [Consultor Financeiro IA · Pré-fase] Configuração ÚNICA do chat conversacional.
// Fonte de verdade: docs/architecture/consultor-financeiro-ia/baseline-v1.2.md
//
// REGRA (Baseline v1.2): nenhum valor de quota / timeout / replay do Consultor pode
// ficar hardcoded fora deste módulo. Tudo é lido de process.env com default seguro.
//
// Os limites diários (free/pro) são PROVISÓRIOS [NV-owner] e ajustáveis por env sem
// alterar arquitetura. Os parâmetros operacionais usam os valores aprovados na Baseline.

function intFromEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`[chatConfig] ${name} inválido: "${raw}" (esperado inteiro >= 0)`);
  }
  return n;
}

const chatConfig = Object.freeze({
  // Quota diária ai_chat (Baseline §4). DEFAULTS PROVISÓRIOS — confirmar com o owner.
  quota: Object.freeze({
    freeDailyLimit: intFromEnv('AI_CHAT_FREE_DAILY_LIMIT', 5),   // TEMP
    proDailyLimit:  intFromEnv('AI_CHAT_PRO_DAILY_LIMIT', 50),   // TEMP
    // marcador explícito de provisoriedade (não decide nada; documenta intenção)
    limitsAreProvisional: true,
  }),

  // Máquina de estados / reconciliação do turno (Baseline §3/§4, RFC0004 §4).
  turn: Object.freeze({
    ttlStaleAdmittedSeconds: intFromEnv('AI_CHAT_TTL_STALE_ADMITTED_SECONDS', 300),   // RFC0004
    llmTimeoutMs:            intFromEnv('AI_CHAT_LLM_TIMEOUT_MS', 120000),             // RFC0004
    maxToolIterations:       intFromEnv('AI_CHAT_MAX_TOOL_ITERATIONS', 8),            // Baseline §5
  }),

  // Replay / idempotência (Baseline §5 / Apêndice A).
  replay: Object.freeze({
    conflictHttpStatus: intFromEnv('AI_CHAT_REPLAY_CONFLICT_STATUS', 409),            // RFC0004
  }),
});

module.exports = chatConfig;
