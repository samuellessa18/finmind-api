'use strict';

// [Consultor · 1D] Cliente Anthropic PRÓPRIO do chat — NÃO reusa getClient da FASE 5 (intocável).
// Repete o PADRÃO (lazy SDK, maxRetries:0, timeout próprio, ANTHROPIC_API_KEY compartilhada), mas é
// um cliente separado, com __test seams próprios (espelhando o padrão de testabilidade da FASE 5).

let _client = null;
const __test = {
  loadSdk: () => require('@anthropic-ai/sdk'),
  resetClient: () => { _client = null; },
};

function getApiKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return typeof k === 'string' && k.trim() !== '' ? k.trim() : null;
}

function getChatClient() {
  if (_client) return _client;
  const Anthropic = __test.loadSdk();
  const Ctor = Anthropic && Anthropic.default ? Anthropic.default : Anthropic;
  _client = new Ctor({
    apiKey: getApiKey(),
    timeout: Number(process.env.AI_CHAT_LLM_TIMEOUT_MS) || 120000, // ms (SDK TS = ms); alinha com o withTimeout do orquestrador
    maxRetries: 0, // conversate NÃO re-tenta; falha PROPAGA → orquestrador → ERROR (D1C-2)
  });
  return _client;
}

module.exports = { getChatClient, __test };
