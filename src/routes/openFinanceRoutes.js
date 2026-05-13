'use strict';

const express = require('express');
const prisma  = require('../../prisma/client');
const { authenticateToken } = require('../middleware/auth');
const { connectLimiter, syncLimiter } = require('../middleware/openFinanceLimiter');
const {
  initConnect,
  completeConnect,
  syncConnection,
  disconnectBank,
  importTransactions,
} = require('../services/openFinanceService');

const router = express.Router();

// All routes require auth
router.use(authenticateToken);

// ─── POST /connect/init ───────────────────────────────────────
// Returns a Connect Token for the Pluggy widget
router.post('/connect/init', connectLimiter, async (req, res, next) => {
  try {
    const result = await initConnect(req.user.id);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── POST /connect/complete ───────────────────────────────────
// Called after widget completes — registers the connection
router.post('/connect/complete', connectLimiter, async (req, res, next) => {
  const { itemId } = req.body;
  if (!itemId || typeof itemId !== 'string') {
    return res.status(400).json({ error: 'itemId requerido.' });
  }
  try {
    const connection = await completeConnect(req.user.id, itemId);
    return res.status(201).json({ connection });
  } catch (err) {
    next(err);
  }
});

// ─── GET /connections ─────────────────────────────────────────
router.get('/connections', async (req, res, next) => {
  try {
    const connections = await prisma.bankConnection.findMany({
      where: { userId: req.user.id },
      select: {
        id:              true,
        institutionId:   true,
        institutionName: true,
        institutionLogo: true,
        status:          true,
        errorCode:       true,
        errorMessage:    true,
        consentExpiresAt: true,
        lastSyncAt:      true,
        lastSyncTxCount: true,
        createdAt:       true,
        // Deliberately omit pluggyItemIdEnc and pluggyItemIdHmac
        accounts: {
          select: {
            id:          true,
            type:        true,
            subtype:     true,
            name:        true,
            number:      true,
            balance:     true,
            balanceDate: true,
            currencyCode: true,
          },
        },
      },
    });
    return res.json({ connections });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /connections/:id ──────────────────────────────────
router.delete('/connections/:id', async (req, res, next) => {
  try {
    await disconnectBank(req.user.id, req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

// ─── POST /connections/:id/sync ───────────────────────────────
router.post('/connections/:id/sync', syncLimiter, async (req, res, next) => {
  try {
    const connection = await prisma.bankConnection.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!connection) return res.status(404).json({ error: 'Conexão não encontrada.' });

    const result = await syncConnection(connection, req.user.id);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── GET /accounts ────────────────────────────────────────────
router.get('/accounts', async (req, res, next) => {
  try {
    const accounts = await prisma.bankAccount.findMany({
      where: { userId: req.user.id },
      select: {
        id:          true,
        type:        true,
        subtype:     true,
        name:        true,
        number:      true,
        balance:     true,
        balanceDate: true,
        currencyCode: true,
        connection: {
          select: {
            institutionName: true,
            institutionLogo: true,
            status:          true,
          },
        },
      },
    });
    return res.json({ accounts });
  } catch (err) {
    next(err);
  }
});

// ─── GET /transactions ────────────────────────────────────────
// Query params: accountId?, from?, to?, page?, pageSize?
router.get('/transactions', async (req, res, next) => {
  try {
    const { accountId, from, to, page = '1', pageSize = '50' } = req.query;
    const take = Math.min(Number(pageSize) || 50, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const where = {
      userId: req.user.id,
      importedTxId: null,       // only unimported (pending review)
    };
    if (accountId) where.accountId = accountId;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to)   where.date.lte = new Date(to);
    }

    const [transactions, total] = await Promise.all([
      prisma.bankTransaction.findMany({
        where,
        orderBy: { date: 'desc' },
        take,
        skip,
        select: {
          id:              true,
          date:            true,
          description:     true,
          amount:          true,
          currencyCode:    true,
          type:            true,
          pluggyCategory:  true,
          finmindCategory: true,
          merchant:        true,
          balance:         true,
          account: {
            select: { name: true, type: true },
          },
        },
      }),
      prisma.bankTransaction.count({ where }),
    ]);

    return res.json({ transactions, total, page: Number(page), pageSize: take });
  } catch (err) {
    next(err);
  }
});

// ─── POST /transactions/import ────────────────────────────────
// Imports selected bank transactions into FinMind's Transaction table
router.post('/transactions/import', async (req, res, next) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids deve ser um array não vazio.' });
  }
  if (ids.length > 100) {
    return res.status(400).json({ error: 'Máximo 100 transações por importação.' });
  }

  try {
    const imported = await importTransactions(req.user.id, ids);
    return res.json({ imported, count: imported.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
