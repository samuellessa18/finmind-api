'use strict';

// [Consultor · 1D] Tools financeiras READ-ONLY + toolExecutor (D2). "o motor calcula, a IA narra":
// os NÚMEROS vêm das funções financeiras determinísticas; o LLM apenas narra.
//
// R-BUDGET (read-only ESTRUTURAL): importa SOMENTE listWithConsumption por nome — budgetService exporta
//   upsert/update/delete no MESMO módulo; nunca são importados aqui.
// R-PII: cada tool tem sanitize() que define EXATAMENTE quais campos saem ao provider. get_risk_level
//   dropa dailyData/predictedData/userMonthlyIncome (PII-rico de getDetailedChartData).
// Anti-IDOR: o handler usa SEMPRE o userId da closure; o input do LLM é ignorado (schemas vazios).
// Fan-in (R1C-9): toolExecutor SEMPRE retorna uma string (nunca undefined) — desconhecida/erro → JSON de erro.
// TX-safety: handlers são read-only (findMany/findUnique); nunca $transaction, FOR UPDATE ou advisory lock.

const { getGeneralSummary, getFinancialScore, getDetailedChartData } = require('../../financeService');
const { listWithConsumption } = require('../../budgetService'); // SÓ a read-only (R-BUDGET)
const { listPatterns } = require('../../patternService');

const EMPTY_SCHEMA = { type: 'object', properties: {}, required: [], additionalProperties: false };

const TOOLS = [
  {
    name: 'get_financial_summary',
    description: 'Resumo financeiro do usuário: saldo total, receitas, despesas, taxa de poupança e tendência.',
    input_schema: EMPTY_SCHEMA,
    handler: (userId) => getGeneralSummary(userId),
    sanitize: (r) => ({
      totalBalance: r.totalBalance, totalIncome: r.totalIncome, totalExpenses: r.totalExpenses,
      savingsRate: r.savingsRate, trend: r.trend, trendDirection: r.trendDirection,
    }),
  },
  {
    name: 'get_financial_score',
    description: 'Score financeiro determinístico do usuário, faixa (band) e evolução vs. ~mês anterior.',
    input_schema: EMPTY_SCHEMA,
    handler: (userId) => getFinancialScore(userId),
    sanitize: (r) => ({
      score: r.score, band: r.band, breakdown: r.breakdown,
      previousScore: r.previousScore, delta: r.delta, message: r.message,
    }),
  },
  {
    name: 'get_budgets',
    description: 'Orçamentos por categoria do usuário e o consumo atual de cada um.',
    input_schema: EMPTY_SCHEMA,
    handler: (userId) => listWithConsumption(userId),
    // computeBudgetConsumption retorna monthlyLimit/pct (não limit/percentage) — mapear pelos nomes reais.
    sanitize: (rows) => (Array.isArray(rows) ? rows : []).map((b) => ({
      category: b.category, limit: b.monthlyLimit, spent: b.spent, percentage: b.pct, status: b.status,
    })),
  },
  {
    name: 'get_spending_patterns',
    description: 'Padrões de gasto detectados (categoria, severidade, variação percentual).',
    input_schema: EMPTY_SCHEMA,
    handler: (userId) => listPatterns(userId),
    sanitize: (rows) => (Array.isArray(rows) ? rows : []).map((p) => ({
      category: p.category, severity: p.severity, percentage: p.percentage, detectedAt: p.detectedAt, message: p.message,
    })),
  },
  {
    name: 'get_risk_level',
    description: 'Nível de risco financeiro projetado para o mês e o saldo projetado.',
    input_schema: EMPTY_SCHEMA,
    handler: (userId) => getDetailedChartData(userId),
    // R-PII: SÓ riskLevel + balanceProjection. Dropa dailyData/predictedData/userMonthlyIncome.
    sanitize: (r) => ({
      riskLevel: r && r.riskAnalysis ? r.riskAnalysis.level : null,
      balanceProjection: r ? r.balanceProjection : null,
    }),
  },
];

const REGISTRY = new Map(TOOLS.map((t) => [t.name, t]));

// Definições enviadas ao provider (sem handler/sanitize).
function getToolDefinitions() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

// makeToolExecutor(userId) => (toolUse) => Promise<content:string>. content NUNCA undefined (fan-in).
function makeToolExecutor(userId) {
  return async function toolExecutor(toolUse) {
    const name = toolUse && toolUse.name;
    const entry = name ? REGISTRY.get(name) : null;
    if (!entry) return JSON.stringify({ error: 'unknown_tool', name: name || null });
    try {
      const raw = await entry.handler(userId); // userId da CLOSURE (anti-IDOR); input do LLM ignorado
      return JSON.stringify(entry.sanitize(raw));
    } catch (_) {
      return JSON.stringify({ error: 'tool_failed', name: entry.name }); // não propaga → preserva fan-in
    }
  };
}

module.exports = { TOOLS, REGISTRY, getToolDefinitions, makeToolExecutor };
