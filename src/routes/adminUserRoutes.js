'use strict';

// [ADMIN] Painel administrativo de usuários — RBAC por role (NÃO por e-mail).
// Coexiste com adminRoutes.js (que usa x-admin-token para métricas); aqui a
// autorização é baseada em req.user.role, populado por authenticateToken.

const express = require('express');
const { z } = require('zod');
const prisma = require('../../prisma/client');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Campos seguros expostos pelo painel (nunca password/secrets).
const SAFE_USER = {
  id: true, name: true, email: true, role: true, plan: true,
  isPremium: true, onboardingCompleted: true, provider: true, createdAt: true,
};

// ─── Middleware RBAC ───────────────────────────────────────────
function requireAdmin(req, res, next) {
  const role = req.user?.role;
  if (role === 'admin' || role === 'super_admin') return next();
  return res.status(403).json({ error: 'Acesso restrito a administradores.' });
}

function requireSuperAdmin(req, res, next) {
  if (req.user?.role === 'super_admin') return next();
  return res.status(403).json({ error: 'Acesso restrito a super administradores.' });
}

// ─── Auditoria ─────────────────────────────────────────────────
// Grava a trilha dentro da MESMA transação da mutação (consistência).
function writeAudit(db, { adminId, targetUserId, action, before, after }) {
  return db.adminAudit.create({
    data: { adminId, targetUserId, action, before: before ?? undefined, after: after ?? undefined },
  });
}

// ─── Schemas ───────────────────────────────────────────────────
const planSchema    = z.object({ plan: z.enum(['free', 'pro']) });
const roleSchema    = z.object({ role: z.enum(['user', 'admin', 'super_admin']) });
const premiumSchema = z.object({ isPremium: z.boolean() });

// ─── GET /admin/users  (lista + busca) ─────────────────────────
router.get('/users', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const search = (req.query.search || '').toString().trim();
    const where = search
      ? { OR: [
          { name:  { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ] }
      : {};
    const users = await prisma.user.findMany({
      where, select: SAFE_USER, orderBy: { createdAt: 'desc' }, take: 200,
    });
    res.json(users);
  } catch (error) {
    next(error);
  }
});

// ─── GET /admin/users/:id ──────────────────────────────────────
router.get('/users/:id', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: SAFE_USER });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json(user);
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /admin/users/:id/plan  (admin) ──────────────────────
router.patch('/users/:id/plan', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'plan deve ser "free" ou "pro".' });

    const before = await prisma.user.findUnique({ where: { id: req.params.id }, select: SAFE_USER });
    if (!before) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const after = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: req.params.id }, data: { plan: parsed.data.plan }, select: SAFE_USER,
      });
      await writeAudit(tx, { adminId: req.user.id, targetUserId: req.params.id, action: 'update_plan', before, after: updated });
      return updated;
    });
    res.json(after);
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /admin/users/:id/premium  (admin) ───────────────────
router.patch('/users/:id/premium', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const parsed = premiumSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'isPremium deve ser booleano.' });

    const before = await prisma.user.findUnique({ where: { id: req.params.id }, select: SAFE_USER });
    if (!before) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const after = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: req.params.id }, data: { isPremium: parsed.data.isPremium }, select: SAFE_USER,
      });
      await writeAudit(tx, { adminId: req.user.id, targetUserId: req.params.id, action: 'update_premium', before, after: updated });
      return updated;
    });
    res.json(after);
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /admin/users/:id/role  (SOMENTE super_admin) ────────
router.patch('/users/:id/role', authenticateToken, requireSuperAdmin, async (req, res, next) => {
  try {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'role deve ser "user", "admin" ou "super_admin".' });

    // Guarda: super_admin não altera o próprio role (evita auto-lockout).
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'Você não pode alterar seu próprio role.' });

    const before = await prisma.user.findUnique({ where: { id: req.params.id }, select: SAFE_USER });
    if (!before) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const after = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: req.params.id }, data: { role: parsed.data.role }, select: SAFE_USER,
      });
      await writeAudit(tx, { adminId: req.user.id, targetUserId: req.params.id, action: 'update_role', before, after: updated });
      return updated;
    });
    res.json(after);
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /admin/users/:id  (SOMENTE super_admin — destrutivo) ─
router.delete('/users/:id', authenticateToken, requireSuperAdmin, async (req, res, next) => {
  try {
    // Guarda: não excluir a própria conta.
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'Você não pode excluir a própria conta.' });

    const before = await prisma.user.findUnique({ where: { id: req.params.id }, select: SAFE_USER });
    if (!before) return res.status(404).json({ error: 'Usuário não encontrado.' });

    // [Hotfix LGPD #1] O erasure de conta é destrutivo e a trilha (AdminAudit, sem FK)
    // SOBREVIVE ao cascade — então o snapshot NÃO pode reter PII do titular esquecido.
    // Minimiza o `before`: remove name/email (Baseline v1.2 §12, RFC0003/0004). Demais
    // rotas admin (update_*) mantêm SAFE_USER, pois o usuário continua existindo.
    const beforeMinimized = { ...before };
    delete beforeMinimized.name;
    delete beforeMinimized.email;

    await prisma.$transaction(async (tx) => {
      // Auditoria ANTES do delete (AdminAudit não tem FK → sobrevive ao cascade).
      await writeAudit(tx, { adminId: req.user.id, targetUserId: req.params.id, action: 'delete_user', before: beforeMinimized, after: undefined });
      await tx.user.delete({ where: { id: req.params.id } });
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
