'use strict';

// [Consultor · 1C] Seam do provider REAL de chat (tool-use) — DORMENTE/gated (LGPD), como a narração
// da FASE 5.x. O adaptador real do Anthropic com tool-use + as ferramentas financeiras determinísticas
// são uma sub-fase FUNCIONAL futura (o plano de validação da 1C exercita a orquestração com STUB).
//
// Enquanto dormente: buildChatProvider() retorna null → a rota responde 503 chat_unavailable SEM
// consumir cota. NENHUMA chamada externa sem configuração explícita (coerente com getLlmProvider).
//
// A ativação real (futura) construirá um provider.run({messages,tools,signal}) sobre
// anthropicProvider/messages.create com tools, e um toolExecutor que lê do motor financeiro
// determinístico (números do motor, a IA narra). Não implementado aqui por estar fora do escopo
// do plano de validação da 1C e por exigir nova especificação de ferramentas.

function buildChatProvider(/* user */) {
  return null; // dormente: feature de chat não ativada em produção
}

function buildToolExecutor(/* user */) {
  return null; // sem ferramentas até a sub-fase funcional
}

module.exports = { buildChatProvider, buildToolExecutor };
