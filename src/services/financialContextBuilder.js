'use strict';

// [FASE 4.2] Context Builder Financeiro — camada de CONSOLIDAÇÃO (não recalcula).
// Reúne, num único objeto estruturado, os sinais já calculados pelos SERVIÇOS
// EXISTENTES. NÃO usa OpenAI/Claude, NÃO gera texto, NÃO recalcula score/
// orçamento/padrões — apenas orquestra e consolida o que cada serviço já produz.
//
// Fontes (todas serviços existentes):
//   score     ← financeService.getFinancialScore  ({ score, band, breakdown, previousScore, delta, message })
//   summary   ← financeService.getGeneralSummary   ({ totalBalance, totalIncome, totalExpenses, savingsRate, trend, trendDirection })
//   riskLevel ← financeService.getDetailedChartData (riskAnalysis.level) — best-effort: se falhar, riskLevel=null (não derruba o contexto)
//   budgets   ← budgetService.listWithConsumption   (consumo do mês por categoria)
//   patterns  ← patternService.listPatterns         (alertas PATTERN, 90d, detectedAt DESC)

const financeService = require('./financeService');
const budgetService = require('./budgetService');
const patternService = require('./patternService');

async function buildFinancialContext(userId, now = new Date()) {
  const [score, summaryBase, budgets, patterns, chart] = await Promise.all([
    financeService.getFinancialScore(userId),
    financeService.getGeneralSummary(userId),
    budgetService.listWithConsumption(userId, now),
    patternService.listPatterns(userId, now),
    // riskLevel vem de um serviço existente (chart). Best-effort: uma falha aqui
    // não invalida o restante do contexto (riskLevel = null).
    financeService.getDetailedChartData(userId).catch(() => null),
  ]);

  return {
    score: score ?? null,
    summary: {
      ...(summaryBase || {}),
      riskLevel: chart?.riskAnalysis?.level ?? null,
    },
    budgets: Array.isArray(budgets) ? budgets : [],
    patterns: Array.isArray(patterns) ? patterns : [],
    generatedAt: now.toISOString(),
  };
}

module.exports = { buildFinancialContext };
