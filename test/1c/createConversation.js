'use strict';

// [Consultor · F0] Rota de criação de conversa — mock req/res, auth fora (req.user já populado).
// Só cria ChatConversation do usuário; SEM turn/mensagem/LLM/SSE/cota. Escopo por req.user.id.
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { makeCreateConversationHandler } = require('../../src/routes/conversationRoutes');
const { findOwnedConversation } = require('../../src/services/conversation/ownership');

function mockRes() {
  const res = { statusCode: null, jsonBody: undefined, headers: {}, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.jsonBody = o; res.headersSent = true; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}
async function create(prisma, user, body = {}) {
  const res = mockRes();
  await makeCreateConversationHandler({ prisma })({ user, body }, res, () => {});
  return res;
}

module.exports = (ctx) => {
  test('CREATE-CONV · 201 { conversationId, createdAt, title:null }; pertence ao user; ZERO side-effects', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    const res = await create(prisma, u);
    assert.strictEqual(res.statusCode, 201);
    assert.ok(res.jsonBody.conversationId, 'retorna conversationId');
    assert.ok(res.jsonBody.createdAt, 'retorna createdAt');
    assert.strictEqual(res.jsonBody.title, null, 'title nasce null');
    // pertence ao usuário e é encontrável por findOwnedConversation (integra com o /turn futuro)
    const owned = await findOwnedConversation(prisma, { conversationId: res.jsonBody.conversationId, userId: u.id });
    assert.ok(owned, 'conversa pertence ao usuário (findOwnedConversation acha)');
    // SEM efeitos colaterais: nenhum ChatTurn / ChatMessage / ChatUsage
    assert.strictEqual(await prisma.chatTurn.count({ where: { userId: u.id } }), 0, 'não cria turn');
    assert.strictEqual(await prisma.chatMessage.count({ where: { userId: u.id } }), 0, 'não cria mensagem');
    assert.strictEqual(await prisma.chatUsage.count({ where: { userId: u.id } }), 0, 'não consome cota/IA');
  });

  test('CREATE-CONV-TENANT · escopo por req.user.id; body.userId forjado é ignorado', async () => {
    const { prisma } = ctx;
    const uA = await H.seedUser(prisma, { plan: 'free' });
    const uB = await H.seedUser(prisma, { plan: 'free' });
    const res = await create(prisma, uA, { userId: uB.id }); // body tenta forjar B
    const convId = res.jsonBody.conversationId;
    assert.ok(await findOwnedConversation(prisma, { conversationId: convId, userId: uA.id }), 'A é dono');
    assert.strictEqual(await findOwnedConversation(prisma, { conversationId: convId, userId: uB.id }), null, 'B não é dono');
    assert.strictEqual(await prisma.chatConversation.count({ where: { userId: uB.id } }), 0, 'nada criado p/ B');
  });

  test('CREATE-CONV-DISTINTAS · duas criações → ids distintos (múltiplas conversas)', async () => {
    const { prisma } = ctx;
    const u = await H.seedUser(prisma, { plan: 'free' });
    const r1 = await create(prisma, u);
    const r2 = await create(prisma, u);
    assert.notStrictEqual(r1.jsonBody.conversationId, r2.jsonBody.conversationId, 'ids distintos');
    assert.strictEqual(await prisma.chatConversation.count({ where: { userId: u.id } }), 2);
  });
};
