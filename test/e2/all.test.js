'use strict';

// [Consultor · E2] Entry-point da suíte: 1 cluster PG real para TODAS as categorias.
// node --test test/e2/all.test.js

const { before, after, beforeEach } = require('node:test');
const H = require('./harness');

const ctx = {};
before(async () => { Object.assign(ctx, await H.boot()); }, { timeout: 180000 });
after(async () => { if (ctx.stop) await ctx.stop(); });
beforeEach(async () => { if (ctx.prisma) await H.reset(ctx.prisma); });

require('./categories/concurrency')(ctx);
require('./categories/idempotency')(ctx);
require('./categories/drift')(ctx);
require('./categories/refund')(ctx);
require('./categories/reconciliation')(ctx);
require('./categories/bank')(ctx);
require('./categories/performance')(ctx);
