'use strict';

// [Consultor · 1C] C4 — Replay/Idempotência na rota (sobre admitTurn/replayOutcome congelados).
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { runTurn } = require('../../src/services/conversation/orchestrator');
const { admitTurn, refundTurn } = require('../../src/services/chat/chatQuotaService');

const NOW = '2026-06-26T12:00:00.000Z';
const DAY = '2026-06-26';
const KEY = 'kreplay0000000001';
const P = (params) => ({ idempotencyKey: KEY, userMessage: 'oi', plan: 'free', ...params });
async function setup(ctx) { const u = await H.seedUser(ctx.prisma, { plan: 'free' }); const conv = await H.seedConversation(ctx.prisma, u.id); return { u, conv }; }
const stub = () => H.makeProvider([{ stopReason: 'end_turn', text: 'resposta', usage: { input_tokens: 2, output_tokens: 2 } }]);

module.exports = (ctx) => {
  test('C4 · replay in-flight → 202 SEM retomar o provider', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    await admitTurn(prisma, { userId: u.id, conversationId: conv.id, idempotencyKey: KEY, userMessage: 'oi', plan: 'free', nowIso: NOW }); // ADMITTED (in-flight)
    const provider = stub();
    const r = await runTurn({ prisma, provider, sse: H.sink(), metrics: H.metrics(), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'IN_FLIGHT'); assert.strictEqual(r.httpStatus, 202);
    assert.strictEqual(provider.callCount, 0, 'in-flight não retoma o provider');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C4 · replay de turno BILLED → 200 servindo assistant via assistantMessageSeq, sem redispatch', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const r1 = await runTurn({ prisma, provider: stub(), sse: H.sink(), metrics: H.metrics(), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r1.outcome, 'BILLED');
    const provider2 = stub();
    const r2 = await runTurn({ prisma, provider: provider2, sse: H.sink(), metrics: H.metrics(), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r2.outcome, 'REPLAY'); assert.strictEqual(r2.httpStatus, 200);
    assert.strictEqual(r2.served, true);
    assert.strictEqual(r2.content, 'resposta');
    assert.strictEqual(r2.assistantMessageSeq, r1.assistantMessageSeq);
    assert.strictEqual(provider2.callCount, 0, 'replay não redispacha');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1, 'sem 2º débito');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C4/R1C-7 · replay de turno terminal-refundante (REFUNDED) → 200 sem reanimar e SEM corpo', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const adm = await admitTurn(prisma, { userId: u.id, conversationId: conv.id, idempotencyKey: KEY, userMessage: 'oi', plan: 'free', nowIso: NOW });
    await refundTurn(prisma, { turnId: adm.turn.id, userId: u.id, terminal: 'REFUNDED', nowIso: NOW });
    const provider = stub();
    const r = await runTurn({ prisma, provider, sse: H.sink(), metrics: H.metrics(), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'REPLAY'); assert.strictEqual(r.httpStatus, 200);
    assert.strictEqual(r.served, false, 'terminal-refundante: nada a servir (billedAt NULL)');
    assert.strictEqual(r.content, null);
    assert.strictEqual(provider.callCount, 0, 'não reanima');
    const turn = await prisma.chatTurn.findUnique({ where: { id: adm.turn.id } });
    assert.strictEqual(turn.state, 'REFUNDED');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C4 · conflito de requestHash (mesma key, conteúdo diferente) → 409, sem provider', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    await admitTurn(prisma, { userId: u.id, conversationId: conv.id, idempotencyKey: KEY, userMessage: 'conteudo-A', plan: 'free', nowIso: NOW });
    const provider = stub();
    const r = await runTurn({ prisma, provider, sse: H.sink(), metrics: H.metrics(), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id, userMessage: 'conteudo-B' }));
    assert.strictEqual(r.outcome, 'CONFLICT'); assert.strictEqual(r.httpStatus, 409);
    assert.strictEqual(provider.callCount, 0);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C4 · N replays concorrentes mesma key → exatamente 1 dispatch ao provider', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = stub(); // compartilhado: conta dispatches totais
    const res = await H.makeBarrier().run(5, () =>
      runTurn({ prisma, provider, sse: H.sink(), metrics: H.metrics(), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id })));
    const billed = res.filter((x) => x.status === 'fulfilled' && x.value.outcome === 'BILLED').length;
    assert.strictEqual(billed, 1, 'exatamente 1 admissão chega a BILLED');
    assert.strictEqual(provider.callCount, 1, 'apenas 1 dispatch ao provider (demais in-flight/replay)');
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 1);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });
};
