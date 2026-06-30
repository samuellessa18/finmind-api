'use strict';

// [Consultor · 1D.1] Prova que a fiação REAL de produção entrega as tool definitions ao provider.
// Duas asserções complementares (condição do Gate Review):
//   (a) GUARD ESTÁTICO: o server.js importa getToolDefinitions E injeta `tools: getToolDefinitions()`
//       no mount do createConversationRouter — pega regressão de remoção da linha.
//   (b) COMPORTAMENTAL: usando os MESMOS constituintes de produção (buildChatProvider/buildToolExecutor
//       REAIS + getToolDefinitions() REAL), com o ÚNICO seam sendo o transporte do SDK, prova que
//       messages.create recebe body.tools com as 5 ferramentas. Nada de array fabricado à mão.
//   (c) DORMÊNCIA: sem env, buildChatProvider→null → 503 sem cota (1D.1 não rompe a dormência).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./harness');

const { makeTurnHandler } = require('../../src/routes/conversationRoutes');
const { createRateLimiter } = require('../../src/services/conversation/rateLimiter');
const { buildChatProvider, buildToolExecutor } = require('../../src/services/conversation/chatProvider');
const { getToolDefinitions } = require('../../src/services/conversation/tools/financialTools');
const chatLlmClient = require('../../src/services/conversation/chatLlmClient');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
const EXPECTED = ['get_budgets', 'get_financial_score', 'get_financial_summary', 'get_risk_level', 'get_spending_patterns'];
const VALID_KEY = 'k1d1wiring00000001';
const permissiveRL = () => createRateLimiter({ windowMs: 60000, maxInWindow: 1000 });

// SDK fake: o construtor retorna um objeto com messages.create que CAPTURA o body e responde end_turn.
function fakeSdk(capture) {
  return function FakeAnthropic() {
    return {
      messages: {
        create: async (body) => {
          capture.body = body;
          return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    };
  };
}

function setEnv(map) {
  const prev = {};
  for (const [k, v] of Object.entries(map)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

module.exports = (ctx) => {
  // (a) GUARD ESTÁTICO — não depende de DB
  test('WIRING/guard · server.js importa getToolDefinitions e injeta tools no createConversationRouter', () => {
    assert.match(SERVER_SRC, /require\(['"]\.\/services\/conversation\/tools\/financialTools['"]\)/, 'server.js importa financialTools');
    assert.match(SERVER_SRC, /createConversationRouter\(\{[\s\S]*?tools:\s*getToolDefinitions\(\)/, 'tools: getToolDefinitions() dentro do mount');
  });

  // (b) COMPORTAMENTAL — caminho real até messages.create, só o SDK é stub
  test('WIRING/real · fiação de produção entrega as 5 tools a messages.create; turno BILLED', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'pro' });
    const conv = await H.seedConversation(prisma, u.id);
    await H.seedConsent(prisma, u.id, { scope: 'ai_chat' });

    const capture = {};
    const origLoad = chatLlmClient.__test.loadSdk;
    const restoreEnv = setEnv({
      AI_CHAT_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test-1d1',
      AI_CHAT_CANARY_USER_IDS: u.id,
    });
    chatLlmClient.__test.loadSdk = () => fakeSdk(capture);
    chatLlmClient.__test.resetClient();
    try {
      // deps montados com os MESMOS constituintes que o server.js usa (sem array fabricado)
      const deps = {
        prisma,
        rateLimiter: permissiveRL(),
        metrics: H.metrics(),
        buildProvider: buildChatProvider,
        buildToolExecutor,
        tools: getToolDefinitions(),
      };
      const res = H.mockRes();
      await makeTurnHandler(deps)({ user: u, body: { conversationId: conv.id, userMessage: 'oi', idempotencyKey: VALID_KEY } }, res, () => {});

      assert.ok(capture.body, 'messages.create foi chamado (provider real exercitado)');
      assert.ok(Array.isArray(capture.body.tools), 'body.tools é um array (foi enviado ao Anthropic)');
      assert.strictEqual(capture.body.tools.length, 5, 'as 5 tools chegaram ao provider');
      assert.deepStrictEqual(capture.body.tools.map((t) => t.name).sort(), EXPECTED, 'nomes corretos das 5 tools');
      const turn = await prisma.chatTurn.findFirst({ where: { userId: u.id } });
      assert.strictEqual(turn.state, 'BILLED', 'turno cobrado normalmente');
      await H.assertDriftZero(assert, prisma, u.id, turn.dayKey, null);
    } finally {
      chatLlmClient.__test.loadSdk = origLoad;
      chatLlmClient.__test.resetClient();
      restoreEnv();
    }
  });

  // (c) DORMÊNCIA — sem env, mesma fiação → 503 sem consumir cota
  test('WIRING/dormência · sem env, buildChatProvider→null → 503 chat_unavailable, sem cota', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'pro' });
    const conv = await H.seedConversation(prisma, u.id);
    await H.seedConsent(prisma, u.id, { scope: 'ai_chat' });
    const restoreEnv = setEnv({ AI_CHAT_PROVIDER: undefined, AI_CHAT_CANARY_USER_IDS: undefined });
    try {
      const deps = {
        prisma, rateLimiter: permissiveRL(), metrics: H.metrics(),
        buildProvider: buildChatProvider, buildToolExecutor, tools: getToolDefinitions(),
      };
      const res = H.mockRes();
      await makeTurnHandler(deps)({ user: u, body: { conversationId: conv.id, userMessage: 'oi', idempotencyKey: VALID_KEY } }, res, () => {});
      assert.strictEqual(res.statusCode, 503);
      assert.strictEqual(res.jsonBody.error, 'chat_unavailable');
      assert.strictEqual(await H.usageCount(prisma, u.id, H.dayKeyUtc(new Date().toISOString())), 0, 'dormente não consome cota');
    } finally {
      restoreEnv();
    }
  });
};
