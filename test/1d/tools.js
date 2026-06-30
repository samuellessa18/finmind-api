'use strict';

// [Consultor · 1D] Tools financeiras + toolExecutor. Contra Postgres real (serviços financeiros reais).
// Prova: fan-in (sempre string), read-only (zero writes/advisory lock via capture spy), sanitize PII
// (get_risk_level só riskLevel+balanceProjection), anti-IDOR (userId da closure, input ignorado).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { getToolDefinitions, makeToolExecutor, TOOLS } = require('../../src/services/conversation/tools/financialTools');
const budgetService = require('../../src/services/budgetService');

const TOOLS_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'conversation', 'tools', 'financialTools.js'), 'utf8');

async function seedRich(prisma, { plan = 'pro' } = {}) {
  const u = await H.seedUser(prisma, { plan });
  await H.seedTransaction(prisma, u.id, { type: 'income', category: 'salary', amount: 5000 });
  await H.seedTransaction(prisma, u.id, { type: 'expense', category: 'food', amount: 300 });
  await H.seedTransaction(prisma, u.id, { type: 'expense', category: 'transport', amount: 150 });
  await H.seedBudget(prisma, u.id, { category: 'food', monthlyLimit: 500 });
  return u;
}

module.exports = (ctx) => {
  test('TOOLS · getToolDefinitions: 5 tools, schemas vazios, sem handler/sanitize vazando', () => {
    const defs = getToolDefinitions();
    assert.strictEqual(defs.length, 5);
    const names = defs.map((d) => d.name).sort();
    assert.deepStrictEqual(names, ['get_budgets', 'get_financial_score', 'get_financial_summary', 'get_risk_level', 'get_spending_patterns']);
    for (const d of defs) {
      assert.deepStrictEqual(Object.keys(d).sort(), ['description', 'input_schema', 'name']);
      assert.deepStrictEqual(d.input_schema, { type: 'object', properties: {}, required: [], additionalProperties: false });
    }
  });

  test('FAN-IN · executor SEMPRE retorna string (nunca undefined): tool desconhecida → unknown_tool', async () => {
    const exec = makeToolExecutor('uX');
    const out = await exec({ id: 'a', name: 'nao_existe', input: {} });
    assert.strictEqual(typeof out, 'string');
    assert.deepStrictEqual(JSON.parse(out), { error: 'unknown_tool', name: 'nao_existe' });
    const out2 = await exec({ id: 'b' }); // sem name
    assert.deepStrictEqual(JSON.parse(out2), { error: 'unknown_tool', name: null });
  });

  test('FAN-IN · handler que lança → tool_failed (string), não propaga (preserva fan-in)', async () => {
    // get_financial_summary com userId inexistente → getGeneralSummary lança "Usuário não encontrado" → tool_failed.
    const exec = makeToolExecutor('user-que-nao-existe');
    const out = await exec({ id: 'c', name: 'get_financial_summary', input: {} });
    assert.strictEqual(typeof out, 'string');
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.error, 'tool_failed');
    assert.strictEqual(parsed.name, 'get_financial_summary');
  });

  test('READ-ONLY/estrutural · R-BUDGET: importa só listWithConsumption; nunca upsert/update/delete', () => {
    // budgetService EXPÕE mutações no mesmo módulo…
    assert.strictEqual(typeof budgetService.upsertBudget, 'function');
    assert.strictEqual(typeof budgetService.updateBudget, 'function');
    assert.strictEqual(typeof budgetService.deleteBudget, 'function');
    // …mas financialTools NÃO as importa (guard anti-regressão).
    assert.match(TOOLS_SRC, /listWithConsumption/);
    assert.ok(!/upsertBudget|updateBudget|deleteBudget/.test(TOOLS_SRC), 'nenhuma mutação de orçamento importada');
    // nem CHAMADA de $transaction / $executeRaw / advisory lock no módulo das tools (TX-safety R1C-4).
    // (sintaxe de chamada, não prosa de comentário)
    assert.ok(!/\.\$transaction\(|\.\$executeRaw|acquireUserXactLock/.test(TOOLS_SRC), 'sem tx/lock/raw chamados nas tools');
  });

  test('READ-ONLY/runtime · rodar as 5 tools NÃO altera o estado do DB (contagens invariantes)', async () => {
    const { prisma } = ctx;
    const u = await seedRich(prisma);
    const snap = async () => ({
      budget: await prisma.budget.count(), tx: await prisma.transaction.count(),
      goal: await prisma.goal.count(), snapshot: await prisma.dailySnapshot.count(),
      pattern: await prisma.patternAlert.count(),
    });
    const before = await snap();
    const exec = makeToolExecutor(u.id);
    for (const t of TOOLS) {
      const out = await exec({ id: t.name, name: t.name, input: {} });
      assert.strictEqual(typeof out, 'string', `${t.name} retornou string`);
    }
    assert.deepStrictEqual(await snap(), before, 'nenhuma linha criada/alterada/removida pelas tools');
  });

  test('SANITIZE/R-PII · get_risk_level só riskLevel+balanceProjection (sem dailyData/predictedData/income)', async () => {
    const { prisma } = ctx;
    const u = await seedRich(prisma);
    const exec = makeToolExecutor(u.id);
    const out = JSON.parse(await exec({ id: 'r', name: 'get_risk_level', input: {} }));
    assert.deepStrictEqual(Object.keys(out).sort(), ['balanceProjection', 'riskLevel']);
    assert.ok(!('dailyData' in out) && !('predictedData' in out) && !('userMonthlyIncome' in out), 'PII dropada');
  });

  test('SANITIZE · get_financial_summary expõe só os campos do contrato', async () => {
    const { prisma } = ctx;
    const u = await seedRich(prisma);
    const exec = makeToolExecutor(u.id);
    const out = JSON.parse(await exec({ id: 's', name: 'get_financial_summary', input: {} }));
    const allowed = ['savingsRate', 'totalBalance', 'totalExpenses', 'totalIncome', 'trend', 'trendDirection'];
    assert.ok(Object.keys(out).every((k) => allowed.includes(k)), `só campos permitidos; vi ${Object.keys(out)}`);
    for (const k of ['savingsRate', 'totalBalance', 'totalExpenses', 'totalIncome']) assert.ok(k in out, `${k} presente`);
  });

  test('ANTI-IDOR · userId vem da closure; input do LLM (userId alheio) é IGNORADO', async () => {
    const { prisma } = ctx;
    const a = await seedRich(prisma); // tem budget 'food'
    const b = await H.seedUser(prisma, { plan: 'pro' }); // sem budgets
    const execA = makeToolExecutor(a.id);
    // LLM tenta forjar userId do B no input — deve ser ignorado; retorna dados de A (tem 1 budget).
    const out = JSON.parse(await execA({ id: 'g', name: 'get_budgets', input: { userId: b.id } }));
    assert.ok(Array.isArray(out) && out.length >= 1, 'retornou os budgets de A (closure), não de B');
    assert.ok(out.some((x) => x.category === 'food'), 'budget food de A presente');
    // executor de B não enxerga budgets de A
    const execB = makeToolExecutor(b.id);
    const outB = JSON.parse(await execB({ id: 'g2', name: 'get_budgets', input: { userId: a.id } }));
    assert.deepStrictEqual(outB, [], 'B não tem budgets — input forjando A.id é ignorado');
  });
};
