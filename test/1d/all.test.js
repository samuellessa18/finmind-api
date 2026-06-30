'use strict';

// [Consultor · 1D] Entry da suíte de validação da ATIVAÇÃO do provider conversacional.
// 1 cluster Postgres real p/ as categorias DB-backed; as puras (gate/adapter/heartbeat/metrics) não usam ctx.
// node --test test/1d/all.test.js
const { before, after, beforeEach } = require('node:test');
const H = require('./harness');

const ctx = {};
before(async () => { Object.assign(ctx, await H.boot()); }, { timeout: 180000 });
after(async () => { if (ctx.stop) await ctx.stop(); });
beforeEach(async () => { if (ctx.prisma) await H.reset(ctx.prisma); });

// Puras (sem DB)
require('./gate')();
require('./adapter')();
require('./heartbeat')();
require('./metricsRoute')();

// DB-backed
require('./tools')(ctx);
require('./driftGauge')(ctx);
require('./e2e')(ctx);
require('./toolsWiring')(ctx); // [1D.1] fiação real das tool definitions + guard estático
