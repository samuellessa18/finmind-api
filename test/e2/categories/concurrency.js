'use strict';

// [Consultor · E2] Categoria 1 — Concorrência (mesmo user × users diferentes).
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('../harness');
const { admitTurn } = require('../../../src/services/chat/chatQuotaService');

const NOW = '2026-06-26T12:00:00.000Z';
const DAY = '2026-06-26';

function tally(results) {
  const t = { ADMITTED: 0, LIMIT: 0, IN_FLIGHT: 0, REPLAY: 0, CONFLICT: 0, rejected: 0, max: 0 };
  for (const r of results) {
    if (r.status === 'rejected') { t.rejected += 1; continue; }
    t[r.value.outcome] = (t[r.value.outcome] || 0) + 1;
  }
  return t;
}
const admit = (prisma, u, conv, plan, key, msg) =>
  admitTurn(prisma, { userId: u, conversationId: conv, idempotencyKey: key, userMessage: msg, plan, nowIso: NOW });

module.exports = (ctx) => {
  test('C-SAME-2 · 2 simultâneas mesmo user free → count=2, sem 429', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    const conv = await H.seedConversation(prisma, u.id);
    const res = tally(await H.makeBarrier().run(2, (i) => admit(prisma, u.id, conv.id, 'free', 'k' + i, 'm' + i)));
    assert.strictEqual(res.ADMITTED, 2);
    assert.strictEqual(res.LIMIT, 0);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 2);
    assert.strictEqual(await H.countState(prisma, u.id, 'ADMITTED'), 2);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C-SAME-5-EXACT · 5 no limite exato L=5 → 5 admitidas, sem off-by-one', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    const conv = await H.seedConversation(prisma, u.id);
    const res = tally(await H.makeBarrier().run(5, (i) => admit(prisma, u.id, conv.id, 'free', 'k' + i, 'm' + i)));
    assert.strictEqual(res.ADMITTED, 5);
    assert.strictEqual(res.LIMIT, 0);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 5);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C-SAME-6-OVER · 6 (=L+1) → exatamente 5 admitidas + 1×429, count nunca>5', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    const conv = await H.seedConversation(prisma, u.id);
    const res = tally(await H.makeBarrier().run(6, (i) => admit(prisma, u.id, conv.id, 'free', 'k' + i, 'm' + i)));
    assert.strictEqual(res.ADMITTED, 5);
    assert.strictEqual(res.LIMIT, 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 5);
    // rollback total da 6ª: total de turnos == 5 (nenhum órfão)
    const total = await prisma.chatTurn.count({ where: { userId: u.id } });
    assert.strictEqual(total, 5);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C-SAME-50/51 · PRO L=50 → 50 e 50+1×429', async () => {
    const { prisma } = ctx;
    // (i) N=50 exato
    let u = await H.seedUser(prisma, { plan: 'pro' });
    let conv = await H.seedConversation(prisma, u.id);
    let res = tally(await H.makeBarrier().run(50, (i) => admit(prisma, u.id, conv.id, 'pro', 'k' + i, 'm' + i)));
    assert.strictEqual(res.ADMITTED, 50);
    assert.strictEqual(res.LIMIT, 0);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 50);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    // (ii) N=51 estouro de 1
    await H.reset(prisma);
    u = await H.seedUser(prisma, { plan: 'pro' });
    conv = await H.seedConversation(prisma, u.id);
    res = tally(await H.makeBarrier().run(51, (i) => admit(prisma, u.id, conv.id, 'pro', 'k' + i, 'm' + i)));
    assert.strictEqual(res.ADMITTED, 50);
    assert.strictEqual(res.LIMIT, 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 50);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C-SAME-500-STRESS · PRO 500 → exatamente 50/450, count==50, 0 órfãos', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'pro' });
    const conv = await H.seedConversation(prisma, u.id);
    const res = tally(await H.makeBarrier().run(500, (i) => admit(prisma, u.id, conv.id, 'pro', 'k' + i, 'm' + i)));
    assert.strictEqual(res.ADMITTED, 50);
    assert.strictEqual(res.LIMIT, 450);
    assert.strictEqual(res.ADMITTED + res.LIMIT, 500);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 50);
    const total = await prisma.chatTurn.count({ where: { userId: u.id } });
    assert.strictEqual(total, 50, 'nenhum dos 450 deixou turno órfão');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C-DIFF-2 · 2 users distintos → counts independentes, sem bloqueio', async () => {
    const { prisma } = ctx;
    const uA = await H.seedUser(prisma, { plan: 'free' });
    const uB = await H.seedUser(prisma, { plan: 'free' });
    const cA = await H.seedConversation(prisma, uA.id);
    const cB = await H.seedConversation(prisma, uB.id);
    const pair = [uA.id, uB.id]; const conv = [cA.id, cB.id];
    const res = tally(await H.makeBarrier().run(2, (i) => admit(prisma, pair[i], conv[i], 'free', 'k', 'm')));
    assert.strictEqual(res.ADMITTED, 2);
    assert.strictEqual(await H.usageCount(prisma, uA.id, DAY), 1);
    assert.strictEqual(await H.usageCount(prisma, uB.id, DAY), 1);
    await H.assertDriftZero(assert, prisma, uA.id, DAY, NOW);
    await H.assertDriftZero(assert, prisma, uB.id, DAY, NOW);
  });

  test('C-DIFF-5 · 5 users distintos (lacuna dura R6) → 5 counts==1 independentes', async () => {
    const { prisma } = ctx;
    const users = await Promise.all([0, 1, 2, 3, 4].map(() => H.seedUser(prisma, { plan: 'free' })));
    const convs = await Promise.all(users.map((u) => H.seedConversation(prisma, u.id)));
    const res = tally(await H.makeBarrier().run(5, (i) => admit(prisma, users[i].id, convs[i].id, 'free', 'k', 'm')));
    assert.strictEqual(res.ADMITTED, 5);
    assert.strictEqual(res.LIMIT, 0);
    for (const u of users) {
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
      await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    }
  });

  test('C-DIFF-50-LINEAR · 50 users distintos não serializam (throughput não-degenerado)', async () => {
    const { prisma } = ctx;
    // baseline: tempo de 1 admissão isolada
    const ub = await H.seedUser(prisma, { plan: 'free' });
    const cb = await H.seedConversation(prisma, ub.id);
    let t0 = process.hrtime.bigint();
    await admit(prisma, ub.id, cb.id, 'free', 'k', 'm');
    const single = Number(process.hrtime.bigint() - t0) / 1e6;
    // 50 users distintos em paralelo
    const users = await Promise.all(Array.from({ length: 50 }, () => H.seedUser(prisma, { plan: 'free' })));
    const convs = await Promise.all(users.map((u) => H.seedConversation(prisma, u.id)));
    t0 = process.hrtime.bigint();
    const res = tally(await H.makeBarrier().run(50, (i) => admit(prisma, users[i].id, convs[i].id, 'free', 'k', 'm')));
    const wall = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.strictEqual(res.ADMITTED, 50);
    // não-serialização: 50 admissões paralelas custam MUITO menos que 50× a isolada.
    assert.ok(wall < single * 50 * 0.6, `throughput serializado: wall=${wall.toFixed(1)}ms vs 50×single=${(single * 50).toFixed(1)}ms`);
    for (const u of users) assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
  });

  test('C-DIFF-500-SCALE · 500 users distintos → 500 counts==1, sem cross-contamination', async () => {
    const { prisma } = ctx;
    const users = await Promise.all(Array.from({ length: 500 }, () => H.seedUser(prisma, { plan: 'free' })));
    const convs = await Promise.all(users.map((u) => H.seedConversation(prisma, u.id)));
    const res = tally(await H.makeBarrier().run(500, (i) => admit(prisma, users[i].id, convs[i].id, 'free', 'k', 'm')));
    assert.strictEqual(res.ADMITTED, 500);
    assert.strictEqual(res.LIMIT, 0);
    const totalTurns = await prisma.chatTurn.count();
    assert.strictEqual(totalTurns, 500);
    // amostra de 5 usuários: cada um count==1, drift zero
    for (const u of [users[0], users[123], users[250], users[400], users[499]]) {
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
      await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    }
  });

  test('C-DROP-1 · 50 simultâneas MESMA idempotencyKey → exatamente 1 admissão, count=1', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    const conv = await H.seedConversation(prisma, u.id);
    // mesma key + mesmo conteúdo (mesmo requestHash) em todas as 50
    const res = tally(await H.makeBarrier().run(50, () => admit(prisma, u.id, conv.id, 'free', 'SAME', 'mesma-msg')));
    assert.strictEqual(res.ADMITTED, 1, 'exatamente 1 admissão');
    assert.strictEqual((res.IN_FLIGHT || 0) + (res.REPLAY || 0), 49, '49 replays/in-flight');
    assert.strictEqual(res.LIMIT, 0);
    assert.strictEqual(res.CONFLICT, 0);
    const total = await prisma.chatTurn.count({ where: { userId: u.id } });
    assert.strictEqual(total, 1, 'unique impede duplicata');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1, 'cota consumida UMA vez');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C-DRIFT-1 · drift pós-admissão concorrente: C==B+A+D+S, S=0, A==count', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    const conv = await H.seedConversation(prisma, u.id);
    await H.makeBarrier().run(5, (i) => admit(prisma, u.id, conv.id, 'free', 'k' + i, 'm' + i));
    const x = await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    assert.strictEqual(x.s, 0);
    assert.strictEqual(x.b, 0);
    assert.strictEqual(x.d, 0);
    assert.strictEqual(x.a, x.c);
  });
};
