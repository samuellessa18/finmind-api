'use strict';

// [Consultor · E2] Harness de validação contra Postgres REAL efêmero.
//  - boot(): sobe 1 cluster UTF8 (binário oficial), migrate deploy, devolve prisma + stop.
//  - reset(): TRUNCATE rápido entre testes (isolamento determinístico).
//  - barrier/assertDriftZero/spy/fault: primitivas exigidas pelo plano (§2).

const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { execSync } = require('child_process');

const config = require('../../src/config/chatConfig');
const TTL = config.turn.ttlStaleAdmittedSeconds;
const LLM_SEC = Math.ceil(config.turn.llmTimeoutMs / 1000);

const EmbeddedPostgresMod = require('embedded-postgres');
const EmbeddedPostgres = EmbeddedPostgresMod.default || EmbeddedPostgresMod;

let _seq = 0;
const uniq = (p) => `${p}_${process.pid}_${Date.now().toString(36)}_${_seq++}`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

async function boot() {
  process.env.PGCLIENTENCODING = 'UTF8';
  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), 'finmind-e2-' + process.pid + '-' + port);
  fs.rmSync(dataDir, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'max_connections=200', '-c', 'fsync=off', '-c', 'synchronous_commit=off'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('finmind_test');

  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/finmind_test?connection_limit=60&pool_timeout=30`;
  execSync('npx prisma migrate deploy --schema=./prisma/schema.prisma', {
    cwd: path.join(__dirname, '..', '..'), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
  });

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url } },
    log: [{ emit: 'event', level: 'query' }],
  });
  // Captura de queries (spy do advisory lock + contagem de queries para perf).
  let capturing = false;
  let captured = [];
  prisma.$on('query', (e) => { if (capturing) captured.push(e.query); });
  const capture = {
    start() { capturing = true; captured = []; },
    stop() { capturing = false; return captured.slice(); },
    advisoryLocks() { return captured.filter((q) => /pg_advisory_xact_lock/i.test(q)).length; },
  };
  await prisma.$connect();

  async function stop() {
    try { await prisma.$disconnect(); } catch (_) {}
    try { await pg.stop(); } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return { prisma, url, stop, pg, dataDir, capture };
}

async function reset(prisma) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ChatMessage","ChatTurn","ChatUsage","ChatConversation","UserConsent","ChatErasureAudit","User" RESTART IDENTITY CASCADE'
  );
}

async function seedUser(prisma, { plan = 'free' } = {}) {
  return prisma.user.create({ data: { name: uniq('u'), email: uniq('e') + '@t.dev', password: 'x', plan } });
}

async function seedConversation(prisma, userId, id) {
  return prisma.chatConversation.create({ data: { id: id || uniq('conv'), userId } });
}

// ─── Barreira de partida: libera N closures ao mesmo tempo ────────────────────
function makeBarrier() {
  let release;
  const gate = new Promise((r) => { release = r; });
  return {
    gate,
    release: () => release(),
    // roda N tarefas que esperam a barreira antes de executar fn(i)
    async run(n, fn) {
      const tasks = Array.from({ length: n }, (_, i) => (async () => { await gate; return fn(i); })());
      release();
      return Promise.allSettled(tasks);
    },
  };
}

// ─── Oráculo de drift S-aware (R2/R15): tudo derivado do DB, filtrado por dayKey ─
async function driftSnapshot(prisma, userId, dayKey, nowIso = null) {
  const rows = nowIso
    ? await prisma.$queryRaw`
        SELECT
          COALESCE((SELECT count FROM "ChatUsage" WHERE "userId"=${userId} AND "dayKey"=${dayKey}),0)::int AS c,
          count(*) FILTER (WHERE state='BILLED')::int AS b,
          count(*) FILTER (WHERE state='ADMITTED'    AND "updatedAt" >= ${new Date(nowIso)}::timestamptz - make_interval(secs=>${TTL}))::int AS a,
          count(*) FILTER (WHERE state='DISPATCHING' AND COALESCE("providerCallStartedAt","updatedAt") >= ${new Date(nowIso)}::timestamptz - make_interval(secs=>${LLM_SEC}))::int AS d,
          count(*) FILTER (WHERE (state='ADMITTED'    AND "updatedAt" < ${new Date(nowIso)}::timestamptz - make_interval(secs=>${TTL}))
                              OR (state='DISPATCHING' AND COALESCE("providerCallStartedAt","updatedAt") < ${new Date(nowIso)}::timestamptz - make_interval(secs=>${LLM_SEC})))::int AS s
        FROM "ChatTurn" WHERE "userId"=${userId} AND "dayKey"=${dayKey}`
    : await prisma.$queryRaw`
        SELECT
          COALESCE((SELECT count FROM "ChatUsage" WHERE "userId"=${userId} AND "dayKey"=${dayKey}),0)::int AS c,
          count(*) FILTER (WHERE state='BILLED')::int AS b,
          count(*) FILTER (WHERE state='ADMITTED'    AND "updatedAt" >= now() - make_interval(secs=>${TTL}))::int AS a,
          count(*) FILTER (WHERE state='DISPATCHING' AND COALESCE("providerCallStartedAt","updatedAt") >= now() - make_interval(secs=>${LLM_SEC}))::int AS d,
          count(*) FILTER (WHERE (state='ADMITTED'    AND "updatedAt" < now() - make_interval(secs=>${TTL}))
                              OR (state='DISPATCHING' AND COALESCE("providerCallStartedAt","updatedAt") < now() - make_interval(secs=>${LLM_SEC})))::int AS s
        FROM "ChatTurn" WHERE "userId"=${userId} AND "dayKey"=${dayKey}`;
  const r = rows[0];
  return { c: r.c, b: r.b, a: r.a, d: r.d, s: r.s, sum: r.b + r.a + r.d + r.s };
}

// assertDriftZero: C == B+A+D+S (asserção final OBRIGATÓRIA de todo cenário — R2)
async function assertDriftZero(assert, prisma, userId, dayKey, nowIso = null) {
  const x = await driftSnapshot(prisma, userId, dayKey, nowIso);
  assert.strictEqual(x.c, x.sum, `DRIFT≠0: C=${x.c} ≠ B+A+D+S=${x.sum} (B=${x.b},A=${x.a},D=${x.d},S=${x.s}) user=${userId} day=${dayKey}`);
  return x;
}

// ─── Contagens utilitárias ────────────────────────────────────────────────────
async function countState(prisma, userId, state) {
  const r = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "ChatTurn" WHERE "userId"=${userId} AND state=${state}`;
  return r[0].n;
}
async function usageCount(prisma, userId, dayKey) {
  const r = await prisma.chatUsage.findUnique({ where: { userId_dayKey: { userId, dayKey } } });
  return r ? r.count : 0;
}
function dayKeyUtc(nowIso) { return new Date(nowIso).toISOString().slice(0, 10); }

// erro sintético com SQLSTATE (injeção de 40001/40P01)
function pgError(sqlstate, msg) {
  const e = new Error((msg || 'injected') + ' ' + sqlstate);
  e.meta = { code: sqlstate };
  return e;
}

// ─── Backdating determinístico p/ cenários stale/timeout (R16) ─────────────────
// Envelhece os timestamps de um turno usando o relógio REAL do Postgres (now()),
// via SQL bruto (NÃO dispara o @updatedAt do Prisma). Permite classificar D/S pelo
// now() do Postgres sem depender do relógio do Node.
async function backdateTurn(prisma, turnId, { updatedAtSecAgo = null, providerStartedSecAgo = null } = {}) {
  if (updatedAtSecAgo != null) {
    await prisma.$executeRaw`UPDATE "ChatTurn" SET "updatedAt" = now() - make_interval(secs => ${updatedAtSecAgo}) WHERE id = ${turnId}`;
  }
  if (providerStartedSecAgo != null) {
    await prisma.$executeRaw`UPDATE "ChatTurn" SET "providerCallStartedAt" = now() - make_interval(secs => ${providerStartedSecAgo}) WHERE id = ${turnId}`;
  }
}

// ISO deslocado em `ms` a partir de uma base (relógio controlável p/ boundary tests).
function isoPlus(baseIso, ms) { return new Date(Date.parse(baseIso) + ms).toISOString(); }

module.exports = {
  boot, reset, seedUser, seedConversation, makeBarrier,
  driftSnapshot, assertDriftZero, countState, usageCount, dayKeyUtc,
  pgError, uniq, TTL, LLM_SEC, backdateTurn, isoPlus,
};
