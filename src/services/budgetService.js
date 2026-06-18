'use strict';

const prisma = require('../../prisma/client');
const { computeBudgetConsumption } = require('../engine/financialEngine');

// Lista orçamentos do usuário + consumo do MÊS CORRENTE (calculado ao vivo).
async function listWithConsumption(userId, now = new Date()) {
  const budgets = await prisma.budget.findMany({
    where: { userId },
    orderBy: { category: 'asc' },
  });
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const transactions = await prisma.transaction.findMany({
    where: { userId, type: 'expense', date: { gte: monthStart, lte: now } },
    select: { category: true, amount: true, date: true, type: true },
  });
  return computeBudgetConsumption(budgets, transactions, now);
}

// Define/atualiza o limite de uma categoria (1 por categoria — upsert).
async function upsertBudget(userId, category, monthlyLimit) {
  return prisma.budget.upsert({
    where: { userId_category: { userId, category } },
    update: { monthlyLimit },
    create: { userId, category, monthlyLimit },
  });
}

async function updateBudget(userId, id, monthlyLimit) {
  const existing = await prisma.budget.findFirst({ where: { id, userId } });
  if (!existing) return null;
  return prisma.budget.update({ where: { id }, data: { monthlyLimit } });
}

async function deleteBudget(userId, id) {
  const r = await prisma.budget.deleteMany({ where: { id, userId } });
  return r.count > 0;
}

module.exports = { listWithConsumption, upsertBudget, updateBudget, deleteBudget };
