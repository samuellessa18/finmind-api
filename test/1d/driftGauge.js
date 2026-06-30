'use strict';

// [Consultor · 1D] driftGauge — SELECT read-only que espelha a janela de _findStaleForUser (E2).
// drift = C - (B+A+D+S). Prova: estado consistente → 0; ChatUsage corrompida → !=0; ADMITTED stale
// (backdated > TTL) é absorvido por S (drift continua 0, igual à reconciliação).
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { computeDriftSnapshot, isDriftNonZero } = require('../../src/services/conversation/driftGauge');

const DAY = '2026-06-30';

async function mkConv(prisma, userId) { return H.seedConversation(prisma, userId); }
async function mkTurn(prisma, { conversationId, userId, seq, state, dayKey = DAY }) {
  // CHECK ChatTurn_billed_consistency_chk: (state='BILLED') ⟺ (billedAt IS NOT NULL)
  const billedAt = state === 'BILLED' ? new Date() : null;
  return prisma.chatTurn.create({ data: { conversationId, userId, seq, requestHash: 'h' + seq, state, dayKey, billedAt } });
}
async function setUsage(prisma, userId, count, dayKey = DAY) {
  return prisma.chatUsage.upsert({
    where: { userId_dayKey: { userId, dayKey } }, create: { userId, dayKey, count }, update: { count },
  });
}

module.exports = (ctx) => {
  test('DRIFT · sem dados → snapshot vazio; isDriftNonZero=false', async () => {
    const rows = await computeDriftSnapshot(ctx.prisma);
    assert.deepStrictEqual(rows, []);
    assert.strictEqual(isDriftNonZero(rows), false);
  });

  test('DRIFT · consistente (C=1, 1 BILLED) → drift 0', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma); const conv = await mkConv(prisma, u.id);
    await mkTurn(prisma, { conversationId: conv.id, userId: u.id, seq: 1, state: 'BILLED' });
    await setUsage(prisma, u.id, 1);
    const rows = await computeDriftSnapshot(prisma);
    const r = rows.find((x) => x.userId === u.id);
    assert.ok(r, 'linha presente'); assert.strictEqual(r.drift, 0);
    assert.deepStrictEqual([r.c, r.b, r.a, r.d, r.s], [1, 1, 0, 0, 0]);
    assert.strictEqual(isDriftNonZero(rows), false);
  });

  test('DRIFT · ADMITTED recente (dentro do TTL) → conta em A, drift 0', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma); const conv = await mkConv(prisma, u.id);
    await mkTurn(prisma, { conversationId: conv.id, userId: u.id, seq: 1, state: 'ADMITTED' });
    await setUsage(prisma, u.id, 1);
    const r = (await computeDriftSnapshot(prisma)).find((x) => x.userId === u.id);
    assert.deepStrictEqual([r.c, r.a, r.drift], [1, 1, 0]);
  });

  test('DRIFT · ChatUsage corrompida (C=3, 1 BILLED) → drift=2, isDriftNonZero=true', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma); const conv = await mkConv(prisma, u.id);
    await mkTurn(prisma, { conversationId: conv.id, userId: u.id, seq: 1, state: 'BILLED' });
    await setUsage(prisma, u.id, 3);
    const rows = await computeDriftSnapshot(prisma);
    const r = rows.find((x) => x.userId === u.id);
    assert.strictEqual(r.drift, 2);
    assert.strictEqual(isDriftNonZero(rows), true);
  });

  test('DRIFT · ADMITTED stale (backdated > TTL) → absorvido por S; drift 0 (espelha reconciliação)', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma); const conv = await mkConv(prisma, u.id);
    const t = await mkTurn(prisma, { conversationId: conv.id, userId: u.id, seq: 1, state: 'ADMITTED' });
    await H.backdateTurn(prisma, t.id, { updatedAtSecAgo: H.TTL + 60 });
    await setUsage(prisma, u.id, 1);
    const r = (await computeDriftSnapshot(prisma)).find((x) => x.userId === u.id);
    assert.deepStrictEqual([r.c, r.a, r.s, r.drift], [1, 0, 1, 0], 'stale entra em S, não em A; drift 0');
  });
};
