'use strict';

// [Consultor · 1C] C1/C2/C5/C9 — orquestração do turno (provider STUB, zero I/O).
// assertDriftZero (oráculo E2 selado) é a asserção final de todo cenário.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { runTurn } = require('../../src/services/conversation/orchestrator');
const { admitTurn, refundTurn } = require('../../src/services/chat/chatQuotaService');

const NOW = '2026-06-26T12:00:00.000Z';
const DAY = '2026-06-26';

async function setup(ctx, plan = 'free') {
  const u = await H.seedUser(ctx.prisma, { plan });
  const conv = await H.seedConversation(ctx.prisma, u.id);
  return { u, conv };
}
const P = (params) => ({ idempotencyKey: 'k0000000000000001', userMessage: 'oi', plan: 'free', ...params });

module.exports = (ctx) => {
  test('C1-ORDER · admit→dispatch→bill; done reflete o assistant PERSISTIDO (não os deltas)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([{ stopReason: 'end_turn', text: 'Resposta final', usage: { input_tokens: 10, output_tokens: 5 } }]);
    const sse = H.sink(); const m = H.metrics();
    const r = await runTurn({ prisma, provider, sse, metrics: m, nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'BILLED'); assert.strictEqual(r.httpStatus, 200);
    const turn = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(turn.state, 'BILLED'); assert.ok(turn.billedAt);
    assert.strictEqual(turn.usageInputTokens, 10); assert.strictEqual(turn.usageOutputTokens, 5);
    const asst = await prisma.chatMessage.findFirst({ where: { turnId: turn.id, role: 'assistant' } });
    assert.strictEqual(asst.content, 'Resposta final');
    assert.ok(sse.has('done')); assert.strictEqual(sse.ofType('done')[0].payload.content, 'Resposta final');
    assert.strictEqual(sse.ofType('done')[0].payload.assistantMessageSeq, asst.assistantMessageSeq);
    assert.strictEqual(sse.has('error'), false);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C1/R1C-2 · usage adapter: soma rounds e traduz {input_tokens}→{input}, NUNCA NULL', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([
      { stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'gasto', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } },
      { stopReason: 'end_turn', text: 'pronto', usage: { input_tokens: 3, output_tokens: 7 } },
    ]);
    const r = await runTurn({ prisma, provider, sse: H.sink(), metrics: H.metrics(), tools: [{ name: 'gasto' }], toolExecutor: H.makeToolExecutor({}), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'BILLED');
    const turn = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(turn.usageInputTokens, 13); // somado (10+3), não NULL
    assert.strictEqual(turn.usageOutputTokens, 12); // (5+7)
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C1/R1C-1 · dispatch-lost via transição REAL (refund antes do dispatch) → provider NUNCA chamado', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([{ stopReason: 'end_turn', text: 'x' }]);
    const r = await runTurn({
      prisma, provider, sse: H.sink(), metrics: H.metrics(), nowIso: NOW,
      _afterAdmit: async (turn) => { await refundTurn(prisma, { turnId: turn.id, userId: u.id, terminal: 'REFUNDED', nowIso: NOW }); },
    }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'DISPATCH_LOST'); assert.strictEqual(r.httpStatus, 503);
    assert.strictEqual(provider.callCount, 0, 'dispatched:false ⇒ provider nunca chamado');
    const turn = await prisma.chatTurn.findUnique({ where: { id: r.turn.id } });
    assert.strictEqual(turn.state, 'REFUNDED');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C1 · LIMIT (turn:null) → sem dispatch, sem provider, sem crash', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    for (let i = 0; i < 5; i++) await admitTurn(prisma, { userId: u.id, conversationId: conv.id, idempotencyKey: 'k' + i + '00000000000000', userMessage: 'm' + i, plan: 'free', nowIso: NOW });
    const provider = H.makeProvider([{ stopReason: 'end_turn', text: 'x' }]);
    const r = await runTurn({ prisma, provider, sse: H.sink(), metrics: H.metrics(), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id, idempotencyKey: 'k5000000000000000' }));
    assert.strictEqual(r.outcome, 'LIMIT'); assert.strictEqual(r.httpStatus, 429); assert.strictEqual(r.turn, null);
    assert.strictEqual(provider.callCount, 0);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 5);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C5 · provider lança → DISPATCHING→ERROR (refund), nunca bill; 503; métricas', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([{ throw: new Error('provider boom') }]);
    const sse = H.sink(); const m = H.metrics();
    const r = await runTurn({ prisma, provider, sse, metrics: m, nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'ERROR'); assert.strictEqual(r.httpStatus, 503);
    const turn = await prisma.chatTurn.findFirst({ where: { userId: u.id } });
    assert.strictEqual(turn.state, 'ERROR'); assert.strictEqual(turn.billedAt, null);
    assert.strictEqual(await prisma.chatMessage.count({ where: { turnId: turn.id, role: 'assistant' } }), 0);
    assert.strictEqual(sse.has('done'), false); assert.ok(sse.has('error'));
    assert.strictEqual(m.snapshot().provider_error_total, 1);
    assert.strictEqual(m.snapshot().refund_total, 1);
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C5/R1C-4 · advisory lock NÃO é mantido durante o I/O do provider', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    let lockFreeDuringIo = null;
    const provider = H.makeProvider([{
      stopReason: 'end_turn', text: 'ok', usage: { input_tokens: 1, output_tokens: 1 },
      beforeReturn: async () => {
        // pg_try_advisory_xact_lock em conexão separada (auto-commit → libera no fim do statement).
        // got=true ⇒ o lock do usuário estava LIVRE durante o I/O (orquestrador não o reteve).
        const rows = await prisma.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${u.id}::text, 0)) AS got`;
        lockFreeDuringIo = rows[0].got;
      },
    }]);
    const r = await runTurn({ prisma, provider, sse: H.sink(), metrics: H.metrics(), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'BILLED');
    assert.strictEqual(lockFreeDuringIo, true, 'lock do usuário LIVRE durante o provider I/O');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C2/R1C-9 · fan-in: round seguinte carrega EXATAMENTE 1 tool_result por tool_use', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([
      { stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'a', input: {} }, { id: 't2', name: 'b', input: {} }], usage: { input_tokens: 4, output_tokens: 2 } },
      { stopReason: 'end_turn', text: 'fim', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const r = await runTurn({ prisma, provider, sse: H.sink(), metrics: H.metrics(), tools: [{ name: 'a' }, { name: 'b' }], toolExecutor: H.makeToolExecutor({}), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'BILLED');
    // inspeciona o payload do round 2 (2ª chamada ao provider)
    const round2 = provider.calls[1].messages;
    const lastUser = round2[round2.length - 1];
    assert.strictEqual(lastUser.role, 'user');
    const results = lastUser.content.filter((b) => b.type === 'tool_result');
    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(results.map((r2) => r2.tool_use_id).sort(), ['t1', 't2']);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C2/C9 · fan-in mismatch (tool_result ausente) → erro do loop → ERROR', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([{ stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'a', input: {} }], usage: { input_tokens: 2, output_tokens: 0 } }]);
    const m = H.metrics();
    const r = await runTurn({ prisma, provider, sse: H.sink(), metrics: m, tools: [{ name: 'a' }], toolExecutor: H.makeToolExecutor({}, { omit: new Set(['t1']) }), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'ERROR'); assert.strictEqual(r.httpStatus, 503);
    assert.strictEqual((await prisma.chatTurn.findFirst({ where: { userId: u.id } })).state, 'ERROR');
    assert.strictEqual(m.snapshot().provider_error_total, 1);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C2/R1C-11 · MAX_TOOL_ITERATIONS exato (do config) → D1C-1 refund ERROR, nunca cobra', async () => {
    const { prisma } = ctx;
    for (const max of [3, 8]) {
      await H.reset(prisma);
      const { u, conv } = await setup(ctx);
      const provider = H.makeProvider([{ stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'a', input: {} }], usage: { input_tokens: 1, output_tokens: 0 } }]); // nunca end_turn
      const sse = H.sink(); const m = H.metrics();
      const r = await runTurn({ prisma, provider, sse, metrics: m, tools: [{ name: 'a' }], toolExecutor: H.makeToolExecutor({}), maxIterations: max, nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
      assert.strictEqual(r.outcome, 'ERROR');
      assert.strictEqual(provider.callCount, max, `callCount exato = ${max} (sem off-by-one)`);
      const turn = await prisma.chatTurn.findFirst({ where: { userId: u.id } });
      assert.strictEqual(turn.state, 'ERROR'); assert.strictEqual(turn.billedAt, null);
      assert.strictEqual(sse.ofType('error')[0].payload.code, 'max_iterations_exceeded');
      assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0, 'nunca cobra (cota devolvida)');
      await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
    }
  });

  test('C9/C3 · billed:false (reconcile venceu antes do bill) → 503, sem done, phantom_charge', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([{ stopReason: 'end_turn', text: 'resp', usage: { input_tokens: 9, output_tokens: 9 } }]);
    const sse = H.sink(); const m = H.metrics();
    const r = await runTurn({
      prisma, provider, sse, metrics: m, nowIso: NOW,
      _beforeBill: async (turnId) => { await refundTurn(prisma, { turnId, userId: u.id, terminal: 'ERROR', nowIso: NOW }); }, // reconcile/erro venceu
    }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'BILLED_FALSE'); assert.strictEqual(r.httpStatus, 503);
    assert.strictEqual(sse.has('done'), false); assert.ok(sse.has('error'));
    assert.strictEqual(m.snapshot().phantom_charge, 1, 'provider consumiu (usage>0) mas turno foi ERROR');
    const turn = await prisma.chatTurn.findFirst({ where: { userId: u.id } });
    assert.strictEqual(turn.state, 'ERROR');
    assert.strictEqual(await H.usageCount(prisma, u.id, DAY), 0);
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C3/R1C-5 · falha de escrita de delta (transporte) NÃO aborta o turno', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([{ stopReason: 'end_turn', text: 'resposta', usage: { input_tokens: 2, output_tokens: 2 } }]);
    const sse = H.sink({ failOn: new Set(['delta']) }); const m = H.metrics();
    const r = await runTurn({ prisma, provider, sse, metrics: m, nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'BILLED', 'erro de transporte do delta ≠ erro do turno');
    assert.strictEqual(m.snapshot().provider_error_total, 0);
    assert.strictEqual(m.snapshot().refund_total, 0);
    const turn = await prisma.chatTurn.findFirst({ where: { userId: u.id } });
    assert.strictEqual(turn.state, 'BILLED');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });
};
