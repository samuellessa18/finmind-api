'use strict';

const prisma  = require('../../prisma/client');
const pluggy  = require('./pluggyClient');
const { encrypt, decrypt, hmac } = require('./encryption');

// ─── Category normalization ────────────────────────────────────
// Maps Pluggy's Portuguese category names → FinMind internal categories
const CATEGORY_MAP = {
  // Food & Drink
  'Alimentação e bebidas': 'food',
  'Restaurantes':          'food',
  'Supermercado':          'food',
  'Padaria':               'food',

  // Transport
  'Transporte':            'transport',
  'Transporte público':    'transport',
  'Aplicativo de transporte': 'transport',
  'Combustível':           'transport',
  'Estacionamento':        'transport',

  // Housing
  'Moradia':               'housing',
  'Aluguel':               'housing',
  'Condomínio':            'housing',
  'Conta de energia':      'housing',
  'Conta de água':         'housing',
  'Internet e telefone':   'housing',

  // Health
  'Saúde':                 'health',
  'Farmácia':              'health',
  'Médico':                'health',
  'Plano de saúde':        'health',

  // Entertainment
  'Lazer e entretenimento': 'entertainment',
  'Streaming':             'entertainment',
  'Cinema':                'entertainment',

  // Shopping
  'Compras':               'shopping',
  'Vestuário':             'shopping',
  'Eletrônicos':           'shopping',

  // Education
  'Educação':              'education',

  // Transfers / Income
  'Transferência':         'transfer',
  'Pix recebido':          'income',
  'Salário':               'income',
  'Renda':                 'income',
};

function normalizeCategory(pluggyCategory) {
  if (!pluggyCategory) return 'other';
  return CATEGORY_MAP[pluggyCategory] ?? 'other';
}

// ─── Connect flow ──────────────────────────────────────────────

/**
 * Step 1: Returns a Connect Token so the mobile/web widget can open.
 */
async function initConnect(userId) {
  const connectToken = await pluggy.createConnectToken(userId, {
    webhook: process.env.PLUGGY_WEBHOOK_URL ?? undefined,
  });
  return { connectToken };
}

/**
 * Step 2: Called after the user completes the widget.
 * itemId is provided by the Pluggy widget callback.
 */
async function completeConnect(userId, itemId) {
  const item = await pluggy.getItem(itemId);

  // Check if this item is already connected for this user (re-connect scenario)
  const existing = await prisma.bankConnection.findUnique({
    where: { pluggyItemIdHmac: hmac(itemId) },
  });

  if (existing) {
    return prisma.bankConnection.update({
      where: { id: existing.id },
      data: {
        status:      item.status,
        errorCode:   item.error?.code   ?? null,
        errorMessage: item.error?.message ?? null,
        updatedAt:   new Date(),
      },
    });
  }

  const connection = await prisma.bankConnection.create({
    data: {
      userId,
      pluggyItemIdEnc:  encrypt(itemId),
      pluggyItemIdHmac: hmac(itemId),
      institutionId:    String(item.connector?.id ?? ''),
      institutionName:  item.connector?.name ?? 'Banco',
      institutionLogo:  item.connector?.imageUrl ?? null,
      status:           item.status,
      consentExpiresAt: item.consentData?.expirationDate
        ? new Date(item.consentData.expirationDate)
        : null,
    },
  });

  // Kick off first sync immediately
  await syncConnection(connection, userId);
  return connection;
}

// ─── Sync ──────────────────────────────────────────────────────

/**
 * Incremental sync for a single connection.
 * Fetches only transactions since lastSyncAt (or all if first sync).
 */
async function syncConnection(connection, userId) {
  const itemId = decrypt(connection.pluggyItemIdEnc);
  const item   = await pluggy.getItem(itemId);

  // Update connection status
  await prisma.bankConnection.update({
    where: { id: connection.id },
    data: {
      status:      item.status,
      errorCode:   item.error?.code   ?? null,
      errorMessage: item.error?.message ?? null,
    },
  });

  if (item.status !== 'UPDATED') {
    return { synced: 0, status: item.status };
  }

  const pluggyAccounts = await pluggy.getAccounts(itemId);

  let totalSynced = 0;

  for (const pluggyAccount of pluggyAccounts) {
    // Upsert account
    const account = await prisma.bankAccount.upsert({
      where: { pluggyAccountIdHmac: hmac(pluggyAccount.id) },
      update: {
        balance:     pluggyAccount.balance ?? 0,
        balanceDate: pluggyAccount.itemLastUpdatedAt
          ? new Date(pluggyAccount.itemLastUpdatedAt)
          : new Date(),
        updatedAt: new Date(),
      },
      create: {
        connectionId:        connection.id,
        userId,
        pluggyAccountIdEnc:  encrypt(pluggyAccount.id),
        pluggyAccountIdHmac: hmac(pluggyAccount.id),
        type:                pluggyAccount.type,
        subtype:            pluggyAccount.subtype ?? null,
        name:               pluggyAccount.name,
        number:             pluggyAccount.number
          ? pluggyAccount.number.slice(-4)   // last 4 digits only
          : null,
        balance:     pluggyAccount.balance ?? 0,
        balanceDate: new Date(),
        currencyCode: pluggyAccount.currencyCode ?? 'BRL',
      },
    });

    // Incremental: only fetch since last sync
    const fromDate = connection.lastSyncAt
      ? connection.lastSyncAt.toISOString().split('T')[0]
      : undefined;

    // Paginate all transactions
    let page = 1;
    let totalPages = 1;
    const newTxs = [];

    do {
      const result = await pluggy.getTransactions(pluggyAccount.id, {
        from: fromDate,
        page,
        pageSize: 500,
      });
      totalPages = result.totalPages;

      for (const tx of result.results) {
        newTxs.push({
          accountId:        account.id,
          userId,
          pluggyTxId:       tx.id,
          date:             new Date(tx.date),
          description:      tx.description ?? tx.descriptionRaw ?? '',
          amount:           tx.amount,
          currencyCode:     tx.currencyCode ?? 'BRL',
          type:             tx.type,
          pluggyCategory:   tx.category ?? null,
          finmindCategory:  normalizeCategory(tx.category),
          merchant:         tx.merchant?.name ?? null,
          balance:          tx.balance ?? null,
        });
      }

      page++;
    } while (page <= totalPages);

    // Bulk upsert — skip duplicates by pluggyTxId
    if (newTxs.length > 0) {
      for (const tx of newTxs) {
        await prisma.bankTransaction.upsert({
          where:  { pluggyTxId: tx.pluggyTxId },
          update: {
            description:     tx.description,
            finmindCategory: tx.finmindCategory,
            merchant:        tx.merchant,
            balance:         tx.balance,
          },
          create: tx,
        });
      }
      totalSynced += newTxs.length;
    }
  }

  await prisma.bankConnection.update({
    where: { id: connection.id },
    data: {
      lastSyncAt:      new Date(),
      lastSyncTxCount: totalSynced,
    },
  });

  return { synced: totalSynced, status: item.status };
}

/**
 * Syncs all connections for a user (called from webhook or manual trigger).
 */
async function syncAllConnections(userId) {
  const connections = await prisma.bankConnection.findMany({
    where: { userId },
  });
  const results = [];
  for (const conn of connections) {
    try {
      const r = await syncConnection(conn, userId);
      results.push({ connectionId: conn.id, ...r });
    } catch (err) {
      results.push({ connectionId: conn.id, error: err.message });
    }
  }
  return results;
}

// ─── Disconnect ────────────────────────────────────────────────

async function disconnectBank(userId, connectionId) {
  const connection = await prisma.bankConnection.findFirst({
    where: { id: connectionId, userId },
  });
  if (!connection) throw Object.assign(new Error('Conexão não encontrada'), { status: 404 });

  const itemId = decrypt(connection.pluggyItemIdEnc);
  try {
    await pluggy.deleteItem(itemId);
  } catch (err) {
    // If already deleted on Pluggy's side (404), proceed with local cleanup
    if (err.response?.status !== 404) throw err;
  }

  await prisma.bankConnection.delete({ where: { id: connectionId } });
}

// ─── Consent expiry job ────────────────────────────────────────

/**
 * Marks connections whose consent has expired (run daily via cron).
 */
async function checkConsentExpiry() {
  const now = new Date();
  const expired = await prisma.bankConnection.findMany({
    where: {
      consentExpiresAt: { lt: now },
      status: { not: 'LOGIN_ERROR' },
    },
    select: { id: true },
  });

  if (expired.length === 0) return 0;

  await prisma.bankConnection.updateMany({
    where: { id: { in: expired.map(c => c.id) } },
    data:  { status: 'LOGIN_ERROR', errorCode: 'CONSENT_EXPIRED' },
  });

  return expired.length;
}

// ─── Import to FinMind transactions ───────────────────────────

/**
 * Imports selected BankTransactions into the user's Transaction table.
 */
async function importTransactions(userId, bankTxIds) {
  const bankTxs = await prisma.bankTransaction.findMany({
    where: {
      id:     { in: bankTxIds },
      userId,
      importedTxId: null,      // not already imported
    },
  });

  const created = [];
  for (const btx of bankTxs) {
    const tx = await prisma.transaction.create({
      data: {
        userId,
        type:        btx.amount >= 0 ? 'income' : 'expense',
        category:    btx.finmindCategory ?? 'other',
        amount:      Math.abs(btx.amount),
        date:        btx.date,
        description: btx.description,
      },
    });
    await prisma.bankTransaction.update({
      where: { id: btx.id },
      data:  { importedTxId: tx.id },
    });
    created.push(tx.id);
  }

  return created;
}

module.exports = {
  initConnect,
  completeConnect,
  syncConnection,
  syncAllConnections,
  disconnectBank,
  checkConsentExpiry,
  importTransactions,
};
