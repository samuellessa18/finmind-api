'use strict';

// [E2 · spike] Prova que o harness de teste funciona ponta-a-ponta:
// (1) sobe um Postgres REAL efêmero (binário oficial via embedded-postgres),
// (2) aplica TODAS as migrations (baseline → consultor_e1) com prisma migrate deploy,
// (3) valida features que a suíte exige: advisory lock, CAS, CHECK 23514, partial index.
// Descartável: datadir em os.tmpdir(), removido no fim.

const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { execSync } = require('child_process');

const EmbeddedPostgresMod = require('embedded-postgres');
const EmbeddedPostgres = EmbeddedPostgresMod.default || EmbeddedPostgresMod;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function main() {
  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), 'finmind-e2-spike-' + process.pid + '-' + port);
  fs.rmSync(dataDir, { recursive: true, force: true });

  // Cluster em UTF8 (igual ao Render/prod). Sem isto, o initdb no Windows herda
  // WIN1252 do locale e rejeita caracteres UTF-8 (ex.: comentários da migration).
  process.env.PGCLIENTENCODING = 'UTF8';
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  console.log('[spike] initialise() em', dataDir, 'porta', port);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('finmind_test');

  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/finmind_test`;
  console.log('[spike] PG real no ar. Aplicando migrations…');

  execSync('npx prisma migrate deploy --schema=./prisma/schema.prisma', {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    // (a) tabelas E1 existem
    const tables = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ChatTurn','ChatUsage','ChatConversation','ChatMessage','UserConsent','ChatErasureAudit') ORDER BY 1`
    );
    console.log('[spike] tabelas E1:', tables.map((t) => t.table_name).join(', '));

    // (b) advisory lock 64-bit funciona
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('user_abc'::text, 0))`);
    });
    console.log('[spike] pg_advisory_xact_lock(hashtextextended(...)) OK');

    // (c) CHECK 23514 billedAt<=>BILLED é ativo (espera erro)
    const u = await prisma.user.create({ data: { name: 'spike', email: `spike+${port}@t.dev`, password: 'x' } });
    const conv = await prisma.chatConversation.create({ data: { id: 'conv_spike', userId: u.id } });
    let checkFired = false;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ChatTurn" (id, "conversationId", "userId", seq, "requestHash", state, "dayKey", "billedAt", "createdAt", "updatedAt")
         VALUES ('turn_bad', 'conv_spike', $1, 1, 'fmqh1:x', 'ADMITTED', '2026-06-26', now(), now(), now())`,
        u.id
      );
    } catch (e) {
      checkFired = e.message.includes('billed_consistency') || (e.meta && String(e.meta.code) === '23514') || e.message.includes('23514');
    }
    console.log('[spike] CHECK billedAt<=>BILLED dispara em ADMITTED+billedAt:', checkFired);

    // (d) partial index existe
    const idx = await prisma.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename='ChatTurn' AND indexname='ChatTurn_reconciliation_idx'`
    );
    console.log('[spike] índice parcial de reconciliação presente:', idx.length === 1);

    const ok = tables.length === 6 && checkFired && idx.length === 1;
    console.log(ok ? '\n[spike] ✅ HARNESS REAL FUNCIONA — Postgres real, migrations, advisory lock, CHECK, partial index.' : '\n[spike] ❌ algo falhou.');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await prisma.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('[spike] teardown ok (datadir removido).');
  }
}

main().catch((e) => {
  console.error('[spike] ERRO:', e);
  process.exitCode = 1;
});
