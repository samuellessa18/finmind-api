'use strict';

// [Consultor · E2] Categoria 7 — Performance (métricas coletadas; invariantes robustos).
// Thresholds absolutos são GENEROSOS (embedded-postgres, fsync/synchronous_commit off);
// o que importa são os invariantes: nº de queries CONSTANTE (anti-N+1), 0 retries no caminho
// saudável, razão throughput diff/same ≥ 2.0 (R19), drift gauge FORA da tx quente.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('../harness');
const { admitTurn } = require('../../../src/services/chat/chatQuotaService');

const NOW = '2026-06-26T12:00:00.000Z';
const DAY = '2026-06-26';

const admit = (prisma, u, c, key, msg, plan = 'pro', opts = {}) =>
  admitTurn(prisma, { userId: u, conversationId: c, idempotencyKey: key, userMessage: msg, plan, nowIso: NOW }, opts);

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]; }
async function timed(fn) { const t0 = process.hrtime.bigint(); const v = await fn(); return { v, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; }

module.exports = (ctx) => {
  test('PERF-E2-01 · tempo da tx de admissão (p50/p95/p99) sob limiar generoso', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'pro' });
    const conv = await H.seedConversation(prisma, u.id);
    const samples = [];
    for (let i = 0; i < 50; i++) { const { ms } = await timed(() => admit(prisma, u.id, conv.id, 'k' + i, 'm' + i)); samples.push(ms); }
    samples.sort((a, b) => a - b);
    const p50 = pct(samples, 50); const p95 = pct(samples, 95); const p99 = pct(samples, 99);
    console.log(`    [PERF-E2-01] admit tx ms: p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} p99=${p99.toFixed(2)}`);
    assert.ok(p95 < 2000, `p95=${p95.toFixed(2)}ms acima do limiar generoso (2000ms)`);
  });

  test('PERF-E2-02 · lock wait sob contenção forçada (50 mesmo user) — conclui, sem 429', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'pro' });
    const conv = await H.seedConversation(prisma, u.id);
    const { ms } = await timed(() => H.makeBarrier().run(50, (i) => admit(prisma, u.id, conv.id, 'k' + i, 'm' + i)));
    console.log(`    [PERF-E2-02] 50 admissões serializadas no lock: ${ms.toFixed(1)}ms`);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 50, 'todas serializadas, sem perda/erro');
  });

  test('PERF-E2-03 · nº de queries por admissão é CONSTANTE (detecta N+1)', async () => {
    const { prisma, capture } = ctx;
    const u = await H.seedUser(prisma, { plan: 'pro' });
    const conv = await H.seedConversation(prisma, u.id);
    capture.start(); await admit(prisma, u.id, conv.id, 'k0', 'm0'); const q0 = capture.stop().length;
    for (let i = 1; i < 10; i++) await admit(prisma, u.id, conv.id, 'k' + i, 'm' + i); // acumula 10 turnos
    capture.start(); await admit(prisma, u.id, conv.id, 'k10', 'm10'); const qN = capture.stop().length;
    console.log(`    [PERF-E2-03] queries/admit: vazio=${q0} com10turnos=${qN}`);
    assert.strictEqual(q0, qN, `N+1: queries por admissão cresceram com os dados (${q0} → ${qN})`);
  });

  test('PERF-E2-04 · nº de retries no caminho saudável = 0', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'pro' });
    const conv = await H.seedConversation(prisma, u.id);
    let retries = 0;
    await admit(prisma, u.id, conv.id, 'k', 'm', 'pro', { onRetry: () => { retries += 1; } });
    assert.strictEqual(retries, 0);
  });

  test('PERF-E2-05 · throughput: razão diff/same ≥ 2.0 (lock por-usuário não serializa distintos, R19)', async () => {
    const { prisma } = ctx;
    // same: 50 admissões do MESMO user (serializadas pelo advisory lock)
    const us = await H.seedUser(prisma, { plan: 'pro' });
    const cs = await H.seedConversation(prisma, us.id);
    const same = (await timed(() => H.makeBarrier().run(50, (i) => admit(prisma, us.id, cs.id, 'k' + i, 'm' + i)))).ms;
    await H.reset(prisma);
    // diff: 50 users DISTINTOS (locks distintos → paralelizam)
    const users = await Promise.all(Array.from({ length: 50 }, () => H.seedUser(prisma, { plan: 'pro' })));
    const convs = await Promise.all(users.map((u) => H.seedConversation(prisma, u.id)));
    const diff = (await timed(() => H.makeBarrier().run(50, (i) => admit(prisma, users[i].id, convs[i].id, 'k', 'm')))).ms;
    const ratio = same / diff;
    console.log(`    [PERF-E2-05] same=${same.toFixed(1)}ms diff=${diff.toFixed(1)}ms ratio=${ratio.toFixed(2)}`);
    assert.ok(ratio >= 2.0, `razão diff/same=${ratio.toFixed(2)} < 2.0 (lock estaria serializando demais)`);
  });

  test('PERF-E2-06 · latência do caminho replay/in-flight não regride (coletada)', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'pro' });
    const conv = await H.seedConversation(prisma, u.id);
    await admit(prisma, u.id, conv.id, 'k', 'm'); // admite a chave (1ª vez)
    const replay = [];
    for (let i = 0; i < 20; i++) replay.push((await timed(() => admit(prisma, u.id, conv.id, 'k', 'm'))).ms); // replay da MESMA chave
    replay.sort((a, b) => a - b);
    console.log(`    [PERF-E2-06] replay p50=${pct(replay, 50).toFixed(2)}ms p95=${pct(replay, 95).toFixed(2)}ms`);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1, 'replay nunca re-debita');
  });

  test('PERF-E2-07 · custo de observabilidade de drift FICA FORA da tx de admissão', async () => {
    const { prisma, capture } = ctx;
    const u = await H.seedUser(prisma, { plan: 'pro' });
    const conv = await H.seedConversation(prisma, u.id);
    capture.start(); await admit(prisma, u.id, conv.id, 'k', 'm'); const q = capture.stop();
    // a admissão NÃO computa o agregado de drift (FILTER por estado) — gauge é caminho separado
    const driftInHotPath = q.some((s) => /FILTER \(WHERE state='BILLED'\)/i.test(s) || /count\(\*\) FILTER/i.test(s));
    assert.strictEqual(driftInHotPath, false, 'agregado de drift não está na tx de admissão');
    // e o snapshot de drift é read-only (não muta count)
    const before = await H.usageCount(prisma, u.id, DAY);
    await H.driftSnapshot(prisma, u.id, DAY, NOW);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), before, 'driftSnapshot é read-only');
  });
};
