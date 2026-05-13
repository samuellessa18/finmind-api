'use strict';

const express = require('express');
const crypto  = require('crypto');
const prisma  = require('../../prisma/client');
const { hmac } = require('../services/encryption');
const { syncConnection } = require('../services/openFinanceService');

const router = express.Router();

function verifySignature(rawBody, signature) {
  const secret = process.env.PLUGGY_WEBHOOK_SECRET;
  if (!secret) return true; // Skip in dev if secret not set

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const sigBuf  = Buffer.from(signature ?? '',  'utf8');
  const expBuf  = Buffer.from(expected,          'utf8');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// POST /webhooks/pluggy
// Note: must be mounted BEFORE express.json() so rawBody is preserved
router.post('/webhooks/pluggy', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-pluggy-signature'] ?? '';
  if (!verifySignature(req.body, signature)) {
    console.warn('[PLUGGY_WEBHOOK] Assinatura inválida — ignorando');
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Payload inválido' });
  }

  // Acknowledge immediately — process async
  res.json({ ok: true });

  const { event: eventType, itemId } = event;

  if (!itemId) return;
  if (!['ITEM_UPDATED', 'ITEM_ERROR', 'ITEM_LOGIN_ERROR'].includes(eventType)) return;

  try {
    const connection = await prisma.bankConnection.findUnique({
      where: { pluggyItemIdHmac: hmac(itemId) },
    });

    if (!connection) {
      console.warn(`[PLUGGY_WEBHOOK] Item ${itemId.slice(0, 8)}... não encontrado no banco`);
      return;
    }

    if (eventType === 'ITEM_UPDATED') {
      await syncConnection(connection, connection.userId);
    } else {
      // ITEM_ERROR or ITEM_LOGIN_ERROR — update status only
      await prisma.bankConnection.update({
        where: { id: connection.id },
        data: {
          status:       eventType === 'ITEM_LOGIN_ERROR' ? 'LOGIN_ERROR' : 'OUTDATED',
          errorCode:    event.error?.code    ?? null,
          errorMessage: event.error?.message ?? null,
        },
      });
    }
  } catch (err) {
    console.error('[PLUGGY_WEBHOOK] Erro ao processar evento:', err.message);
  }
});

module.exports = router;
