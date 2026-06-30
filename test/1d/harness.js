'use strict';

// [Consultor · 1D] Harness — REUSA o harness 1C (que reusa o E2: Postgres real, reset, seeds, drift,
// makeProvider/makeToolExecutor stub, sink, metrics) e adiciona primitivas 1D:
//   - stubSdkClient: fake do SDK Anthropic (messages.create) → ZERO rede; valida adapter+e2e.
//   - mockRes: req/res falso (igual ao 1C route.js) p/ exercitar makeTurnHandler.
//   - seedTransaction/seedBudget: dados financeiros reais p/ as tools read-only.

const C1 = require('../1c/harness');

// As tools chamam os serviços financeiros REAIS (financeService/budgetService/patternService), que usam o
// SINGLETON prisma/client. No Prisma 5 a URL é fixada na CONSTRUÇÃO do client — e o singleton é construído
// no module-load (quando financialTools é exigido), ANTES do boot() conhecer a porta do Postgres efêmero.
// Solução SÓ-DE-TESTE (zero mudança no código de produção): injetamos no require.cache, ANTES de qualquer
// require de financialTools, um PROXY preguiçoso no caminho de prisma/client que encaminha para o prisma
// de teste (ctx.prisma) assim que o boot() o cria. financeService captura ESTE proxy como seu `prisma`.
let _realPrisma = null;
const prismaProxy = new Proxy({}, {
  get(_t, prop) {
    if (!_realPrisma) throw new Error('[1d harness] prisma singleton usado antes do boot()');
    const v = _realPrisma[prop];
    return typeof v === 'function' ? v.bind(_realPrisma) : v;
  },
});
const singletonPath = require.resolve('../../prisma/client');
require.cache[singletonPath] = { id: singletonPath, filename: singletonPath, loaded: true, exports: prismaProxy };

async function boot() {
  const base = await C1.boot();
  _realPrisma = base.prisma; // a partir daqui, o "singleton" das tools é o prisma de teste
  return base;
}

// Fake do client do SDK: messages.create(body, opts) consome `script` (último item repete).
// item: resposta NATIVA { content:[...], stop_reason, usage } | { throw: Error } | { delayMs: N, ...resp }
function stubSdkClient(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    get callCount() { return i; },
    messages: {
      create: async (body, opts) => {
        calls.push({ body, opts });
        const item = script[Math.min(i, script.length - 1)] || { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
        i += 1;
        if (item.delayMs != null) await new Promise((r) => setTimeout(r, item.delayMs));
        if (item.throw) throw item.throw;
        return {
          content: item.content || [{ type: 'text', text: item.text || 'ok' }],
          stop_reason: item.stop_reason || 'end_turn',
          usage: item.usage || { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
}

function mockRes() {
  const res = { statusCode: null, jsonBody: undefined, headers: {}, frames: [], headersSent: false, ended: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.jsonBody = o; res.headersSent = true; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.writeHead = (c, h) => { res.statusCode = c; Object.assign(res.headers, h || {}); res.headersSent = true; return res; };
  res.write = (s) => { res.frames.push(s); return true; };
  res.end = () => { res.ended = true; return res; };
  res.wire = () => res.frames.join('');
  return res;
}

async function seedTransaction(prisma, userId, { type = 'expense', category = 'food', amount = 50, date = new Date(), description = null } = {}) {
  return prisma.transaction.create({ data: { userId, type, category, amount, date, description } });
}

async function seedBudget(prisma, userId, { category = 'food', monthlyLimit = 500 } = {}) {
  return prisma.budget.create({ data: { userId, category, monthlyLimit } });
}

module.exports = { ...C1, boot, stubSdkClient, mockRes, seedTransaction, seedBudget };
