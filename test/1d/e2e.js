'use strict';

// [Consultor · 1D] End-to-end REAL: makeTurnHandler → runTurn → conversate → adapter REAL → SDK stub,
// + tools REAIS contra Postgres real. Prova a integração viva da ativação (sem rede), incluindo o
// heartbeat (D1D-7) no caminho ADMITTED e a integridade de cota/drift em erro do provider.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { makeTurnHandler } = require('../../src/routes/conversationRoutes');
const { createRateLimiter } = require('../../src/services/conversation/rateLimiter');
const { createChatProvider } = require('../../src/services/conversation/anthropicChatAdapter');
const { makeToolExecutor, getToolDefinitions } = require('../../src/services/conversation/tools/financialTools');

const VALID_KEY = 'k1d000000000000001';
const permissiveRL = () => createRateLimiter({ windowMs: 60000, maxInWindow: 1000 });

async function setup(ctx) {
  const u = await H.seedUser(ctx.prisma, { plan: 'pro' });
  const conv = await H.seedConversation(ctx.prisma, u.id);
  await H.seedConsent(ctx.prisma, u.id, { scope: 'ai_chat' });
  await H.seedTransaction(ctx.prisma, u.id, { type: 'income', category: 'salary', amount: 5000 });
  await H.seedTransaction(ctx.prisma, u.id, { type: 'expense', category: 'food', amount: 300 });
  await H.seedBudget(ctx.prisma, u.id, { category: 'food', monthlyLimit: 500 });
  return { u, conv };
}

function depsFor(ctx, client, { heartbeatMs } = {}) {
  return {
    prisma: ctx.prisma, rateLimiter: permissiveRL(), metrics: H.metrics(),
    buildProvider: () => createChatProvider({ client }),
    buildToolExecutor: (user) => makeToolExecutor(user.id),
    tools: getToolDefinitions(),
    ...(heartbeatMs != null ? { heartbeatMs } : {}),
  };
}

module.exports = (ctx) => {
  test('E2E · resposta única (end_turn) → SSE done, BILLED, cota=1, drift 0', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const client = H.stubSdkClient([{ content: [{ type: 'text', text: 'Seu saldo está saudável.' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 5 } }]);
    const res = H.mockRes();
    await makeTurnHandler(depsFor(ctx, client))({ user: u, body: { conversationId: conv.id, userMessage: 'como estou?', idempotencyKey: VALID_KEY } }, res, () => {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
    const wire = res.wire();
    assert.ok(/event: done/.test(wire), 'frame done emitido');
    assert.ok(/saldo está saudável/.test(wire), 'conteúdo persistido viaja no done');
    const turn = await prisma.chatTurn.findFirst({ where: { userId: u.id } });
    assert.strictEqual(turn.state, 'BILLED');
    assert.strictEqual(await H.usageCount(prisma, u.id, turn.dayKey), 1);
    await H.assertDriftZero(assert, prisma, u.id, turn.dayKey, null);
    // body do request ao SDK: modelo default + tools + system
    assert.strictEqual(client.calls[0].body.model, 'claude-opus-4-8');
    assert.strictEqual(client.calls[0].body.tools.length, 5);
  });

  test('E2E · round de tool REAL (get_financial_summary) → tool_result alimenta o 2º round; BILLED', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const client = H.stubSdkClient([
      { content: [{ type: 'text', text: 'consultando…' }, { type: 'tool_use', id: 'tu1', name: 'get_financial_summary', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 6, output_tokens: 2 } },
      { content: [{ type: 'text', text: 'Pronto: resumo gerado.' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 7 } },
    ]);
    const res = H.mockRes();
    await makeTurnHandler(depsFor(ctx, client))({ user: u, body: { conversationId: conv.id, userMessage: 'resuma', idempotencyKey: VALID_KEY } }, res, () => {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(client.callCount, 2, 'dois rounds');
    // 2ª chamada inclui o tool_result (fan-in real do toolExecutor)
    const msgs2 = client.calls[1].body.messages;
    const toolResult = msgs2.find((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result' && c.tool_use_id === 'tu1'));
    assert.ok(toolResult, 'tool_result tu1 presente no 2º round');
    const tr = toolResult.content.find((c) => c.type === 'tool_result');
    assert.match(tr.content, /totalBalance/, 'conteúdo do tool_result é o JSON sanitizado do motor');
    const turn = await prisma.chatTurn.findFirst({ where: { userId: u.id } });
    assert.strictEqual(turn.state, 'BILLED');
    await H.assertDriftZero(assert, prisma, u.id, turn.dayKey, null);
  });

  test('E2E/D1D-7 · heartbeat: stream aberto + 2º round lento → frames heartbeat no wire', async () => {
    const { u, conv } = await setup(ctx);
    const client = H.stubSdkClient([
      { content: [{ type: 'text', text: 'pensando…' }, { type: 'tool_use', id: 'tu1', name: 'get_financial_summary', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      { delayMs: 80, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const res = H.mockRes();
    await makeTurnHandler(depsFor(ctx, client, { heartbeatMs: 5 }))({ user: u, body: { conversationId: conv.id, userMessage: 'oi', idempotencyKey: VALID_KEY } }, res, () => {});
    const wire = res.wire();
    assert.ok(/event: heartbeat/.test(wire), 'heartbeat emitido durante o round lento (stream já aberto)');
    assert.ok(/event: done/.test(wire), 'done ao final');
  });

  test('E2E · erro do provider → SSE error (transporte 200), cota refundada, drift 0', async () => {
    const { prisma } = ctx; const { u, conv } = await setup(ctx);
    const client = H.stubSdkClient([{ throw: new Error('sdk timeout') }]);
    const res = H.mockRes();
    await makeTurnHandler(depsFor(ctx, client))({ user: u, body: { conversationId: conv.id, userMessage: 'oi', idempotencyKey: VALID_KEY } }, res, () => {});
    // 1C: erro durante o turno ADMITTED emite frame SSE error (abre o stream → transporte 200), NÃO done.
    const wire = res.wire();
    assert.ok(/event: error/.test(wire), 'frame error emitido');
    assert.ok(/provider_error/.test(wire), 'código provider_error');
    assert.ok(!/event: done/.test(wire), 'nunca um done de sucesso');
    const turn = await prisma.chatTurn.findFirst({ where: { userId: u.id } });
    assert.strictEqual(await H.usageCount(prisma, u.id, turn.dayKey), 0, 'cota refundada');
    await H.assertDriftZero(assert, prisma, u.id, turn.dayKey, null);
  });
};
