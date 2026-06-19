'use strict';

// [FASE 5.1] Provider LLM Claude/Anthropic — INFRAESTRUTURA (NÃO ativado).
//
// Implementa a MESMA assinatura esperada pelo seam do financialNarrator (FASE 4.3):
//     isAvailable() => boolean
//     async narrate(context) => { title, summary, recommendations }
//
// Garantias desta fase:
//   - NÃO é importado por nenhum fluxo de produção (server.js / financialNarrator
//     permanecem intocados). A ativação é a FASE 5.2.
//   - Sem ANTHROPIC_API_KEY → isAvailable() = false → NENHUMA chamada externa.
//   - O SDK oficial é carregado de forma LAZY (require dentro de getClient), então
//     a ausência da dependência/instância não afeta nada enquanto inativo.
//   - Mantém a fronteira do projeto: "o motor calcula, a IA narra" (system prompt
//     proíbe recalcular/inventar números).

const DEFAULT_MODEL = 'claude-opus-4-8'; // sobrescrevível por LLM_MODEL (ver FASE 5.2)
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_TOKENS = 1024;

const SYSTEM_PROMPT = [
  'Você é um assistente financeiro que escreve em português do Brasil (pt-BR).',
  'Você recebe um CONTEXTO já calculado pelo motor determinístico (score, resumo,',
  'orçamentos e padrões). Sua função é NARRAR e RECOMENDAR com base nesses números —',
  'NUNCA recalcule, invente, estime ou altere valores; use apenas os dados fornecidos.',
  'Seja claro, conciso e acionável.',
].join(' ');

// JSON Schema da saída — garante o shape { title, summary, recommendations }.
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'recommendations'],
  additionalProperties: false,
};

function getApiKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return typeof k === 'string' && k.trim() !== '' ? k.trim() : null;
}

// true SOMENTE com chave configurada — assegura "nenhuma chamada externa sem chave".
function isAvailable() {
  return getApiKey() !== null;
}

// Carregamento lazy do SDK (não exige a dependência enquanto o provider está inativo).
// `__test` agrupa seams substituíveis em teste (NÃO usar em produção).
let _client = null;
const __test = {
  loadSdk: () => require('@anthropic-ai/sdk'),
  resetClient: () => { _client = null; },
};

function getClient() {
  if (_client) return _client;
  const Anthropic = __test.loadSdk();
  const Ctor = Anthropic && Anthropic.default ? Anthropic.default : Anthropic;
  _client = new Ctor({
    apiKey: getApiKey(),
    timeout: Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxRetries: 0, // narração é interativa; em falha caímos no determinístico (sem retry)
  });
  return _client;
}

/**
 * Narração via Claude. LANÇA em qualquer falha (sem chave, erro/timeout/quota do SDK,
 * resposta inválida) — o seam do narrator captura e cai no determinístico.
 * @param {object} context  saída de buildFinancialContext()
 * @returns {Promise<{title:string, summary:string, recommendations:string[]}>}
 */
async function narrate(context) {
  if (!isAvailable()) throw new Error('anthropicProvider: ANTHROPIC_API_KEY ausente');
  const client = getClient();
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  const res = await client.messages.create({
    model,
    max_tokens: DEFAULT_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content: JSON.stringify(context) }],
  });

  const block = Array.isArray(res && res.content)
    ? res.content.find((b) => b && b.type === 'text')
    : null;
  if (!block || typeof block.text !== 'string') {
    throw new Error('anthropicProvider: resposta do LLM sem bloco de texto');
  }
  const parsed = JSON.parse(block.text);
  return {
    title: String(parsed.title || ''),
    summary: String(parsed.summary || ''),
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : [],
  };
}

module.exports = {
  isAvailable,
  narrate,
  // exportados para teste/observabilidade futura (não usados em produção nesta fase):
  SYSTEM_PROMPT,
  OUTPUT_SCHEMA,
  DEFAULT_MODEL,
  __test, // seams de teste (loadSdk / resetClient) — não usar em produção
};
