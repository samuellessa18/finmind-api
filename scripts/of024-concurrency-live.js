'use strict';
/**
 * [GATE-1/OF-024] Teste de concorrência VIVO — prova definitiva da remediação OFC-6.
 *
 * Dispara DUAS importTransactions() concorrentes do MESMO BankTransaction contra um
 * Postgres REAL. O lock de linha do `UPDATE ... WHERE importedTxId IS NULL` deve fazer
 * exatamente UMA vencer → exatamente 1 Transaction criada (sem duplicação).
 *
 * Por que existe: a versão em mock (camada lógica) roda no CI sem banco; este script é a
 * camada de ATOMICIDADE DO BANCO, que só pode ser provada com Postgres real. Rodar no
 * GATE-0 (infra), contra staging ou prod restaurado — NUNCA contra produção viva.
 *
 * Uso:
 *   OF024_LIVE=1 DATABASE_URL=postgres://... node scripts/of024-concurrency-live.js
 *   (em produção, exige também OF024_FORCE=1 — proteção contra execução acidental)
 *
 * Saída: "OF-024 LIVE = PASS" (exit 0) ou "OF-024 LIVE = FAIL" (exit 1).
 */
require('dotenv').config();
const prisma = require('../prisma/client');
const { importTransactions } = require('../src/services/openFinanceService');

async function main() {
  if (process.env.OF024_LIVE !== '1') {
    console.error('Recusado: defina OF024_LIVE=1 para rodar o teste vivo (cria/apaga dados de teste).');
    process.exit(2);
  }
  if (process.env.NODE_ENV === 'production' && process.env.OF024_FORCE !== '1') {
    console.error('Recusado: NODE_ENV=production sem OF024_FORCE=1. Aborte ou use staging.');
    process.exit(2);
  }

  const tag = 'of024-' + Date.now();
  const email = `${tag}@finmind-test.invalid`;
  let userId = null;

  try {
    // ── Seed ────────────────────────────────────────────────────
    const user = await prisma.user.create({ data: { name: 'OF024 Test', email } });
    userId = user.id;
    const conn = await prisma.bankConnection.create({
      data: {
        userId,
        pluggyItemIdEnc:  `${tag}-itemEnc`,
        pluggyItemIdHmac: `${tag}-itemHmac`,
        institutionId:    'test-inst',
        institutionName:  'Banco Teste',
        status:           'UPDATED',
      },
    });
    const acct = await prisma.bankAccount.create({
      data: {
        connectionId: conn.id,
        userId,
        pluggyAccountIdEnc:  `${tag}-acctEnc`,
        pluggyAccountIdHmac: `${tag}-acctHmac`,
        type: 'BANK',
        name: 'Conta Teste',
      },
    });
    const btx = await prisma.bankTransaction.create({
      data: {
        accountId: acct.id,
        userId,
        pluggyTxId: `${tag}-tx`,
        date: new Date('2026-01-15'),
        description: 'Compra teste',
        amount: -42.5,
        type: 'DEBIT',
        finmindCategory: 'food',
        importedTxId: null,
      },
    });

    // ── Disparo concorrente (mesmíssimo btx, em paralelo) ───────
    const results = await Promise.allSettled([
      importTransactions(userId, [btx.id]),
      importTransactions(userId, [btx.id]),
    ]);

    // ── Asserções ───────────────────────────────────────────────
    const txCount = await prisma.transaction.count({ where: { userId } });
    const fresh   = await prisma.bankTransaction.findUnique({ where: { id: btx.id } });
    const rejected = results.filter(r => r.status === 'rejected');
    const created  = results.filter(r => r.status === 'fulfilled').reduce((n, r) => n + r.value.length, 0);

    const okCount   = txCount === 1;                 // exatamente 1 Transaction
    const okClaim   = fresh && fresh.importedTxId;   // btx reclamado 1x
    const okCreated = created === 1;                 // só um import retornou o id
    const okNoThrow = rejected.length === 0;         // perdedor pula (não rejeita)

    console.log(`Transactions criadas .... ${txCount} (esperado 1)`);
    console.log(`btx.importedTxId ........ ${fresh ? fresh.importedTxId : 'null'} (esperado != null)`);
    console.log(`imports que retornaram id ${created} (esperado 1)`);
    console.log(`imports rejeitados ...... ${rejected.length} (esperado 0)`);

    const pass = okCount && okClaim && okCreated && okNoThrow;
    console.log('\nOF-024 LIVE = ' + (pass ? 'PASS' : 'FAIL'));
    process.exitCode = pass ? 0 : 1;
  } catch (err) {
    console.error('Erro no teste vivo:', err);
    process.exitCode = 1;
  } finally {
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => {}); // cascade limpa tudo
    }
    await prisma.$disconnect();
  }
}

main();
