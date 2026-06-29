'use strict';

// [Consultor · 1C] Harness de validação da orquestração. REUSA o harness E2 (Postgres real, reset,
// seedUser/seedConversation, assertDriftZero selado, barreira, capture spy) e adiciona primitivas 1C:
// stub/spy do provider (zero I/O), sink SSE de gravação, instância de métricas, seed de consent.

const E2 = require('../e2/harness');
const { createRecordingSink } = require('../../src/services/conversation/sse');
const { createMetrics } = require('../../src/services/conversation/metrics');

// ─── Stub/SPY do provider conversate (zero I/O real) ──────────────────────────
// script: array de itens consumidos por chamada a run(); o último repete se exceder.
//   { stopReason:'end_turn', text, usage }                              → resposta final
//   { stopReason:'tool_use', toolUses:[{id,name,input}], text?, usage } → round de tool
//   { throw: Error }                                                    → provider lança (maxRetries:0)
//   { hangMs: N }                                                       → demora N ms (estoura timeout)
//   { beforeReturn: async () => {} }                                    → hook (ex.: checar lock/abrir corrida)
function makeProvider(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    get callCount() { return i; },
    async run(args) {
      calls.push({ messages: JSON.parse(JSON.stringify(args.messages || [])), tools: args.tools });
      const item = script[Math.min(i, script.length - 1)] || { stopReason: 'end_turn', text: 'ok' };
      i += 1;
      if (typeof item.beforeReturn === 'function') await item.beforeReturn(args);
      if (item.throw) throw item.throw;
      if (item.hangMs != null) await new Promise((r) => setTimeout(r, item.hangMs));
      return {
        stopReason: item.stopReason || 'end_turn',
        text: item.text || '',
        toolUses: item.toolUses || [],
        usage: item.usage || { input_tokens: 0, output_tokens: 0 },
      };
    },
  };
}

// toolExecutor injetável: map nome->content, ou função. `omit` (Set de ids) força fan-in mismatch.
function makeToolExecutor(resolver, { omit = null } = {}) {
  return async function toolExecutor(tu) {
    if (omit && omit.has(tu.id)) return undefined; // dispara FANIN_MISMATCH
    if (typeof resolver === 'function') return resolver(tu);
    if (resolver && typeof resolver === 'object') return resolver[tu.name] !== undefined ? resolver[tu.name] : `result:${tu.name}`;
    return `result:${tu.name}`;
  };
}

async function seedConsent(prisma, userId, { scope = 'ai_chat', revoked = false } = {}) {
  return prisma.userConsent.create({
    data: { userId, scope, grantedAt: new Date(), revokedAt: revoked ? new Date() : null },
  });
}

// usa o sink de gravação real (mesmos nomes de evento do wire-format congelado)
function sink(opts) { return createRecordingSink(opts); }
function metrics() { return createMetrics(); }

module.exports = {
  ...E2,
  makeProvider, makeToolExecutor, seedConsent, sink, metrics,
};
