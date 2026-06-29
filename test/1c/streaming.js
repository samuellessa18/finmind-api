'use strict';

// [Consultor · 1C] C3 — Streaming SSE: deltas não-autoritativos; done reflete o persistido; disconnect
// não aborta; heartbeat sem efeito de estado.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { runTurn } = require('../../src/services/conversation/orchestrator');
const { admitTurn, dispatchTurn } = require('../../src/services/chat/chatQuotaService');
const { reconcileUserLazy } = require('../../src/services/chat/chatReconciliationService');

const NOW = '2026-06-26T12:00:00.000Z';
const DAY = '2026-06-26';
const P = (params) => ({ idempotencyKey: 'k0000000000000001', userMessage: 'oi', plan: 'free', ...params });
async function setup(ctx) { const u = await H.seedUser(ctx.prisma, { plan: 'free' }); const conv = await H.seedConversation(ctx.prisma, u.id); return { u, conv }; }

module.exports = (ctx) => {
  test('C3 · deltas NÃO-autoritativos: persiste o conteúdo FINAL, não a concatenação dos deltas', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([
      { stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'a', input: {} }], text: 'rascunho parcial...', usage: { input_tokens: 3, output_tokens: 1 } },
      { stopReason: 'end_turn', text: 'Resposta final consolidada', usage: { input_tokens: 2, output_tokens: 4 } },
    ]);
    const sse = H.sink();
    const r = await runTurn({ prisma, provider, sse, metrics: H.metrics(), tools: [{ name: 'a' }], toolExecutor: H.makeToolExecutor({}), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'BILLED');
    const asst = await prisma.chatMessage.findFirst({ where: { turnId: r.turn.id, role: 'assistant' } });
    assert.strictEqual(asst.content, 'Resposta final consolidada'); // NÃO 'rascunho parcial...'
    assert.strictEqual(sse.ofType('done')[0].payload.content, 'Resposta final consolidada');
    assert.ok(sse.ofType('delta').some((d) => d.payload.text === 'rascunho parcial...'), 'delta provisório foi emitido (mas não persistido)');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C3 · disconnect entre bill e done: BILLED não revertido; recuperável por replay', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([{ stopReason: 'end_turn', text: 'resp', usage: { input_tokens: 1, output_tokens: 1 } }]);
    const sse = H.sink({ failOn: new Set(['done']) }); // escrita do done falha (socket fechado)
    const r = await runTurn({ prisma, provider, sse, metrics: H.metrics(), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'BILLED');
    const turn = await prisma.chatTurn.findFirst({ where: { userId: u.id } });
    assert.strictEqual(turn.state, 'BILLED', 'falha ao escrever done NÃO reverte o BILLED');
    assert.ok(sse.ofType('done')[0].writeFailed, 'done falhou no transporte mas o estado persiste');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C3 · disconnect durante o tool-loop (multi-round): completa server-side até BILLED', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const provider = H.makeProvider([
      { stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'a', input: {} }], text: 'p1', usage: { input_tokens: 2, output_tokens: 1 } },
      { stopReason: 'end_turn', text: 'final', usage: { input_tokens: 1, output_tokens: 2 } },
    ]);
    const sse = H.sink({ failOn: new Set(['delta']) }); // cliente foi embora; deltas falham
    const m = H.metrics();
    const r = await runTurn({ prisma, provider, sse, metrics: m, tools: [{ name: 'a' }], toolExecutor: H.makeToolExecutor({}), nowIso: NOW }, P({ userId: u.id, conversationId: conv.id }));
    assert.strictEqual(r.outcome, 'BILLED');
    assert.strictEqual(m.snapshot().refund_total, 0, 'disconnect não refunda');
    assert.strictEqual(provider.callCount, 2, 'loop completou os 2 rounds apesar do disconnect');
    await H.assertDriftZero(assert, prisma, u.id, DAY, NOW);
  });

  test('C3/R1C-14 · heartbeat não toca updatedAt: turno travado ainda reconcilia (janela íntegra)', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const adm = await admitTurn(prisma, { userId: u.id, conversationId: conv.id, idempotencyKey: 'k0000000000000001', userMessage: 'oi', plan: 'free', nowIso: NOW });
    await dispatchTurn(prisma, { turnId: adm.turn.id, userId: u.id, nowIso: NOW });
    const sse = H.sink();
    for (let i = 0; i < 5; i++) sse.heartbeat(); // keep-alive: NÃO escreve no DB
    assert.strictEqual(sse.ofType('heartbeat').length, 5);
    // a âncora da janela (providerCallStartedAt) permanece; envelhece e reconcilia
    await H.backdateTurn(prisma, adm.turn.id, { providerStartedSecAgo: H.LLM_SEC + 60 });
    const rec = await reconcileUserLazy(prisma, { userId: u.id });
    assert.strictEqual(rec.refunded, 1, 'heartbeats não mascararam o turno travado');
    const turn = await prisma.chatTurn.findUnique({ where: { id: adm.turn.id } });
    assert.strictEqual(turn.state, 'ERROR');
    await H.assertDriftZero(assert, prisma, u.id, DAY, null);
  });
};
