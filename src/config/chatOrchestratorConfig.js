'use strict';

// [Consultor · 1C] Config ÚNICA da camada de orquestração (greenfield).
// NÃO altera chatConfig.js (pré-fase, congelado por uso da E2): importa-o read-only onde
// precisa de knobs compartilhados (maxToolIterations, llmTimeoutMs). Tudo via env c/ default seguro.
//
// Wire-format SSE e parâmetros operacionais são decisões do owner (D1C-3): nomes de evento
// congelados (delta/heartbeat/done/error); intervalos/limites parametrizáveis por env.

const chatConfig = require('./chatConfig'); // read-only

function intFromEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error(`[chatOrchestratorConfig] ${name} inválido: "${raw}"`);
  return n;
}

const orchestratorConfig = Object.freeze({
  // Tool loop (D1C-1). maxToolIterations e llmTimeoutMs vêm do chatConfig (fonte única já existente).
  toolLoop: Object.freeze({
    maxIterations: chatConfig.turn.maxToolIterations,   // default 8 (chatConfig)
    llmTimeoutMs: chatConfig.turn.llmTimeoutMs,          // default 120000 (chatConfig)
  }),

  // SSE (D1C-3): nomes de evento CONGELADOS; intervalo/timeout parametrizáveis.
  sse: Object.freeze({
    heartbeatMs: intFromEnv('AI_CHAT_SSE_HEARTBEAT_MS', 15000),
    events: Object.freeze({ DELTA: 'delta', HEARTBEAT: 'heartbeat', DONE: 'done', ERROR: 'error' }),
  }),

  // Rate-limit best-effort por-instância (Apêndice D: distribuído/Redis fora de escopo).
  // NÃO é a fonte de verdade da cota — só o motor E2 é (C7).
  rateLimit: Object.freeze({
    windowMs: intFromEnv('AI_CHAT_RL_WINDOW_MS', 60000),
    maxInWindow: intFromEnv('AI_CHAT_RL_MAX_IN_WINDOW', 30),
    failOpen: process.env.AI_CHAT_RL_FAIL_OPEN !== 'false', // default fail-open (best-effort)
  }),
});

module.exports = orchestratorConfig;
