'use strict';

// [F0.2A] Testes de shutdown/health. Unitários (cross-platform, sem depender de sinal POSIX) +
// integração do health router contra Postgres real efêmero. node --test test/f0/all.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const express = require('express');

const E2 = require('../e2/harness');
const { runShutdown } = require('../../src/lib/gracefulShutdown');
const jobTracker = require('../../src/lib/jobTracker');
const { migrationStatus, readExpectedMigrations } = require('../../src/lib/migrationCheck');
const { createHealthRouter } = require('../../src/routes/healthRoutes');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function get(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 4000 }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

// ─── Unit: migrationStatus (puro) ────────────────────────────────────────────
test('migrationStatus · ok quando todas aplicadas e concluídas', () => {
  const now = new Date();
  const applied = [
    { migration_name: 'a', finished_at: now, rolled_back_at: null },
    { migration_name: 'b', finished_at: now, rolled_back_at: null },
  ];
  assert.deepStrictEqual(migrationStatus(applied, ['a', 'b']), { ok: true, missing: [] });
});
test('migrationStatus · falso-positivo evitado: esperada ausente → not ok (schema drift)', () => {
  const r = migrationStatus([{ migration_name: 'a', finished_at: new Date(), rolled_back_at: null }], ['a', 'b']);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.missing, ['b']);
});
test('migrationStatus · pendente (finished_at null) ou revertida (rolled_back_at) → not ok', () => {
  assert.strictEqual(migrationStatus([{ migration_name: 'a', finished_at: null, rolled_back_at: null }], ['a']).ok, false);
  assert.strictEqual(migrationStatus([{ migration_name: 'a', finished_at: new Date(), rolled_back_at: new Date() }], ['a']).ok, false);
});
test('migrationStatus · ANY-row: rollback+reapply (2 linhas mesmo nome) → ok em QUALQUER ordem', () => {
  const reverted = { migration_name: 'm1', finished_at: new Date(), rolled_back_at: new Date() };
  const reapplied = { migration_name: 'm1', finished_at: new Date(), rolled_back_at: null };
  assert.strictEqual(migrationStatus([reverted, reapplied], ['m1']).ok, true);
  assert.strictEqual(migrationStatus([reapplied, reverted], ['m1']).ok, true); // independe da ordem
});
test('readExpectedMigrations · dir ausente → null (fail-closed, não [])', () => {
  assert.strictEqual(readExpectedMigrations(path.join(__dirname, '__inexistente__')), null);
});

// ─── Unit: jobTracker (guard + drain) ────────────────────────────────────────
test('jobTracker · guardedJob não inicia durante shutdown; drainJobs espera o em voo', async () => {
  jobTracker._reset();
  let ran = 0;
  const job = jobTracker.guardedJob(async () => { await wait(60); ran += 1; });
  const p = job();                                   // inicia (em voo)
  assert.strictEqual(jobTracker.activeJobs(), 1);
  jobTracker.beginShutdown();
  const skipped = await job();                       // shutdown → não inicia
  assert.strictEqual(skipped, undefined);
  assert.strictEqual(ran, 0);                        // ainda em voo
  const drained = await jobTracker.drainJobs(1000);
  await p;
  assert.strictEqual(drained, true);
  assert.strictEqual(ran, 1);                        // o em voo concluiu
  jobTracker._reset();
});
test('jobTracker · drainJobs retorna false se estourar o tempo com job preso', async () => {
  jobTracker._reset();
  const job = jobTracker.guardedJob(async () => { await wait(500); });
  const p = job();
  const drained = await jobTracker.drainJobs(80);
  assert.strictEqual(drained, false);
  await p; jobTracker._reset();
});
test('jobTracker · fn que lança: rejeita mas activeJobs volta a 0 (finally, anti-leak)', async () => {
  jobTracker._reset();
  const job = jobTracker.guardedJob(async () => { throw new Error('boom'); });
  await assert.rejects(job(), /boom/);
  assert.strictEqual(jobTracker.activeJobs(), 0);
  jobTracker._reset();
});

// ─── Unit: runShutdown (ordem + closeAll + drain-antes-de-disconnect) ─────────
test('runShutdown · ordem stop→drain→HTTP→disconnect→flush; drena jobs e HTTP ANTES do $disconnect', async () => {
  const calls = [];
  const fakeServer = {
    closeIdleConnections: () => calls.push('closeIdle'),
    closeAllConnections: () => calls.push('closeAll'),
    close: (cb) => { calls.push('close'); setTimeout(cb, 5); }, // resolve rápido (drenou sozinho)
  };
  await runShutdown({
    httpServer: fakeServer,
    stopScheduling: () => calls.push('stop'),
    drainJobs: async () => { calls.push('drain'); },
    disconnectPrisma: async () => { calls.push('disconnect'); },
    flush: async () => { calls.push('flush'); },
    graceMs: 50,
  });
  assert.deepStrictEqual(
    calls.filter((c) => ['stop', 'drain', 'disconnect', 'flush'].includes(c)),
    ['stop', 'drain', 'disconnect', 'flush'],
  );
  assert.ok(calls.includes('closeIdle'), 'fecha keep-alive ociosos');
  assert.ok(calls.indexOf('drain') < calls.indexOf('disconnect'), 'drena jobs antes de desconectar');
  assert.ok(calls.indexOf('close') < calls.indexOf('disconnect'), 'drena HTTP antes de desconectar');
});
test('runShutdown · SSE preso: força closeAllConnections após o grace e não pendura', async () => {
  const calls = [];
  let closeCb = null;
  const fakeServer = {
    closeIdleConnections: () => calls.push('closeIdle'),
    closeAllConnections: () => { calls.push('closeAll'); if (closeCb) closeCb(); }, // força → close resolve
    close: (cb) => { calls.push('close'); closeCb = cb; },                          // NÃO resolve sozinho
  };
  await runShutdown({ httpServer: fakeServer, disconnectPrisma: async () => calls.push('disconnect'), graceMs: 30 });
  assert.ok(calls.includes('closeAll'), 'closeAllConnections chamado (força SSE)');
  assert.ok(calls.indexOf('closeAll') < calls.indexOf('disconnect'), 'força os sockets antes de desconectar');
});

// ─── Integração: health router contra Postgres real ──────────────────────────
const ctx = {};
let server = null;
let port = 0;
before(async () => {
  Object.assign(ctx, await E2.boot());
  const app = express();
  app.use('/api/health', createHealthRouter({ prisma: ctx.prisma }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }); });
}, { timeout: 180000 });
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (ctx.stop) await ctx.stop();
});

test('health/live · 200 sem tocar o banco (liveness)', async () => {
  const r = await get(port, '/api/health/live');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /liveness/);
});
test('health/ready · 200 com migrations aplicadas', async () => {
  const r = await get(port, '/api/health/ready');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /"migrations":"ok"/);
});
test('health/ready · catálogo ilegível (migrationsDir ausente) → 503 unverifiable (fail-closed)', async () => {
  const app2 = express();
  app2.use('/api/health', createHealthRouter({ prisma: {}, migrationsDir: path.join(__dirname, '__inexistente__') }));
  const s2 = await new Promise((resolve) => { const srv = app2.listen(0, '127.0.0.1', () => resolve(srv)); });
  try {
    const r = await get(s2.address().port, '/api/health/ready');
    assert.strictEqual(r.status, 503);
    assert.match(r.body, /unverifiable/);
  } finally {
    await new Promise((resolve) => s2.close(resolve));
  }
});
test('health/ready · 503 quando uma migration esperada não consta em _prisma_migrations (drift)', async () => {
  // remove a migration mais recente → simula banco atrás do código
  const rows = await ctx.prisma.$queryRaw`SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS LAST LIMIT 1`;
  const name = rows[0].migration_name;
  await ctx.prisma.$executeRaw`DELETE FROM "_prisma_migrations" WHERE migration_name = ${name}`;
  const r = await get(port, '/api/health/ready');
  assert.strictEqual(r.status, 503);
  assert.match(r.body, /incompatible/);
});
