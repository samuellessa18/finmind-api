'use strict';

// [FASE 4.3] Serviço de Narração Financeira.
//
// Consome o objeto produzido por financialContextBuilder (FASE 4.2) e produz uma
// narração { title, summary, recommendations, generatedBy }. INTERPRETA o contexto
// recebido — NÃO chama OpenAI/Claude, NÃO acessa APIs externas, NÃO recalcula
// score/orçamento/padrões. Função pura (sem efeitos colaterais).
//
// SEPARAÇÃO DE CAMADAS:
//   1. Context Builder (financialContextBuilder) → coleta/consolida os sinais.
//   2. Narrator (este arquivo)                   → interpreta o contexto em texto.
//   3. Provider (futuro)                         → LLM plugável no "seam" abaixo.
//
// SEAM PARA LLM FUTURO: um provider LLM implementará a MESMA assinatura
//   async (context) => { title, summary, recommendations }
// e generateFinancialNarration tentará o LLM; em erro/timeout/quota/indisponível,
// cairá para o narrador determinístico. `generatedBy` refletirá a origem real
// ('llm' | 'deterministic'). Nesta fase só existe o determinístico.

// [FASE 5.2] Seam ATIVO: provider LLM (com gate de canário) + observabilidade mínima.
const { getLlmProvider } = require('./llm');
const anthropicProvider = require('./llm/anthropicProvider');
const { logNarration, classifyFallbackReason } = require('./llm/narrationLog');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Contexto "vazio": sem dinheiro movimentado, sem orçamentos, sem padrões e
// sem score efetivo — trata null/undefined e usuário novo (tudo zerado).
function isEmptyContext(context) {
  if (!context) return true;
  const s = context.summary || {};
  const noMoney = (num(s.totalIncome) || 0) === 0 && (num(s.totalExpenses) || 0) === 0;
  const noBudgets = !Array.isArray(context.budgets) || context.budgets.length === 0;
  const noPatterns = !Array.isArray(context.patterns) || context.patterns.length === 0;
  const scoreVal = context.score ? num(context.score.score) : null;
  const noScore = scoreVal === null || scoreVal === 0;
  return noMoney && noBudgets && noPatterns && noScore;
}

// Narrador DETERMINÍSTICO (provider atual). Pura interpretação do contexto.
function deterministicNarrate(context) {
  if (isEmptyContext(context)) {
    return {
      title: 'Vamos começar a entender suas finanças',
      summary: 'Ainda não há dados suficientes para uma análise completa. Registre receitas e despesas para receber um panorama do seu score, orçamentos e padrões de gasto.',
      recommendations: ['Registre suas movimentações para ativar a análise financeira.'],
    };
  }

  const score = context.score || {};
  const summary = context.summary || {};
  const budgets = Array.isArray(context.budgets) ? context.budgets : [];
  const patterns = Array.isArray(context.patterns) ? context.patterns : [];

  const scoreVal = num(score.score);
  const band = typeof score.band === 'string' ? score.band : null;
  const savingsRate = num(summary.savingsRate);
  const riskLevel = (summary.riskLevel || '').toString().toLowerCase();

  const overBudgets = budgets.filter((b) => b.status === 'EXCEDIDO' || b.status === 'CRÍTICO');
  const warnBudgets = budgets.filter((b) => b.status === 'ATENÇÃO');
  const topPatterns = patterns.slice(0, 3);

  // Recomendações acionáveis (determinísticas), em ordem de prioridade.
  const recommendations = [];
  if (riskLevel === 'high') {
    recommendations.push('Seu risco financeiro está alto: reduza gastos não essenciais nos próximos dias.');
  }
  for (const b of overBudgets) {
    recommendations.push(`Orçamento de ${b.category} ${b.status === 'CRÍTICO' ? 'em estado crítico' : 'estourado'} (${b.pct}%). Reveja os gastos nessa categoria.`);
  }
  for (const b of warnBudgets) {
    recommendations.push(`Orçamento de ${b.category} em atenção (${b.pct}%). Acompanhe para não estourar o limite.`);
  }
  for (const p of topPatterns) {
    recommendations.push(`Gastos em ${p.category} subiram ${p.percentage}% vs o mês passado. Vale investigar.`);
  }
  if (savingsRate !== null && savingsRate < 10) {
    recommendations.push(`Sua taxa de economia está em ${Math.round(savingsRate)}%. Tente reservar 10–20% da renda.`);
  }
  if (recommendations.length === 0) {
    recommendations.push('Continue acompanhando seus gastos para manter a trajetória positiva.');
  }

  // Título conforme o estado dominante.
  let title;
  if (riskLevel === 'high' || overBudgets.length > 0) {
    title = 'Atenção: pontos que precisam de ação';
  } else if (band) {
    title = `Sua saúde financeira está ${band}`;
  } else {
    title = 'Panorama financeiro';
  }

  // Resumo: síntese determinística dos sinais presentes.
  const parts = [];
  if (scoreVal !== null) parts.push(`Seu score financeiro é ${scoreVal}${band ? ` (${band})` : ''}.`);
  if (savingsRate !== null) parts.push(`Taxa de economia em ${Math.round(savingsRate)}%.`);
  if (riskLevel) parts.push(`Nível de risco: ${riskLevel}.`);
  if (overBudgets.length) parts.push(`${overBudgets.length} orçamento(s) acima do limite.`);
  else if (warnBudgets.length) parts.push(`${warnBudgets.length} orçamento(s) em atenção.`);
  if (patterns.length) parts.push(`${patterns.length} padrão(ões) de gasto em alta detectado(s).`);
  const summaryText = parts.join(' ') || 'Panorama financeiro disponível.';

  return { title, summary: summaryText, recommendations };
}

/**
 * Gera a narração financeira a partir do contexto (saída do buildFinancialContext).
 * [FASE 5.2] Seam ATIVO: tenta o provider LLM (Claude) SE selecionado, com chave e com
 * o usuário no canário; em QUALQUER falha cai no determinístico. NUNCA lança por causa do
 * provider — o endpoint nunca recebe 500 por erro de IA.
 * @param {object} context  resultado de buildFinancialContext()
 * @param {{userId?: string|number|null}} [options]  userId p/ o gate de canário
 * @returns {Promise<{title:string, summary:string, recommendations:string[], generatedBy:string}>}
 */
async function generateFinancialNarration(context, options = {}) {
  const userId = options.userId != null ? options.userId : null;
  const provider = getLlmProvider(process.env, userId); // null se inativo/sem-chave/fora-do-canário
  const model = process.env.LLM_MODEL || anthropicProvider.DEFAULT_MODEL;
  const t0 = Date.now();

  if (provider) {
    try {
      const llm = await provider.narrate(context);
      logNarration({ generatedBy: 'llm', provider: 'anthropic', model: llm.model || model, duration_ms: Date.now() - t0, fallback_reason: null, usage: llm.usage });
      return { title: llm.title, summary: llm.summary, recommendations: llm.recommendations, generatedBy: 'llm' };
    } catch (e) {
      // Nenhum erro do provider escapa: registra o motivo e cai no determinístico.
      logNarration({ generatedBy: 'deterministic', provider: 'anthropic', model, duration_ms: Date.now() - t0, fallback_reason: classifyFallbackReason(e), usage: null });
      const narration = deterministicNarrate(context);
      return { title: narration.title, summary: narration.summary, recommendations: narration.recommendations, generatedBy: 'deterministic' };
    }
  }

  // Provider inativo (default / sem-chave / fora-do-canário) → determinístico.
  logNarration({ generatedBy: 'deterministic', provider: null, model: null, duration_ms: Date.now() - t0, fallback_reason: 'provider_inactive', usage: null });
  const narration = deterministicNarrate(context);
  return {
    title: narration.title,
    summary: narration.summary,
    recommendations: narration.recommendations,
    generatedBy: 'deterministic',
  };
}

module.exports = { generateFinancialNarration, deterministicNarrate, isEmptyContext };
