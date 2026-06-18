'use strict';

// [ORÇAMENTO] CRUD de limites mensais por categoria de despesa + consumo do mês.
// Montado em /api/v1/budgets. SEM cache no GET (consumo deve refletir cada lançamento).

const express = require('express');
const { z } = require('zod');
const { authenticateToken } = require('../middleware/auth');
const { EXPENSE_CATEGORIES } = require('../constants/categories');
const { listWithConsumption, upsertBudget, updateBudget, deleteBudget } = require('../services/budgetService');

const router = express.Router();

const createSchema = z.object({
  category: z.string().min(1),
  monthlyLimit: z.number().positive(),
}).superRefine((d, ctx) => {
  if (!EXPENSE_CATEGORIES.includes(d.category)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['category'], message: 'Categoria inválida para despesa.' });
  }
});
const updateSchema = z.object({ monthlyLimit: z.number().positive() });

// GET /budgets — lista + consumo do mês corrente
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    res.json(await listWithConsumption(req.user.id));
  } catch (error) {
    next(error);
  }
});

// POST /budgets — define/atualiza limite (upsert por categoria)
router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse({ ...req.body, monthlyLimit: Number(req.body.monthlyLimit) });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors.map((e) => e.message).join(', ') });
    const budget = await upsertBudget(req.user.id, parsed.data.category, parsed.data.monthlyLimit);
    res.json(budget);
  } catch (error) {
    next(error);
  }
});

// PATCH /budgets/:id — atualiza limite
router.patch('/:id', authenticateToken, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse({ monthlyLimit: Number(req.body.monthlyLimit) });
    if (!parsed.success) return res.status(400).json({ error: 'monthlyLimit deve ser um número positivo.' });
    const budget = await updateBudget(req.user.id, req.params.id, parsed.data.monthlyLimit);
    if (!budget) return res.status(404).json({ error: 'Orçamento não encontrado.' });
    res.json(budget);
  } catch (error) {
    next(error);
  }
});

// DELETE /budgets/:id — remove limite
router.delete('/:id', authenticateToken, async (req, res, next) => {
  try {
    const ok = await deleteBudget(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Orçamento não encontrado.' });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
