'use strict';

// [Consultor · 1C] Entry da suíte de validação da orquestração: 1 cluster Postgres real p/ todas as
// categorias. node --test test/1c/all.test.js
const { before, after, beforeEach } = require('node:test');
const H = require('./harness');

const ctx = {};
before(async () => { Object.assign(ctx, await H.boot()); }, { timeout: 180000 });
after(async () => { if (ctx.stop) await ctx.stop(); });
beforeEach(async () => { if (ctx.prisma) await H.reset(ctx.prisma); });

require('./orchestrator')(ctx);
require('./streaming')(ctx);
require('./replay')(ctx);
require('./gates')(ctx);
require('./cron')(ctx);
require('./route')(ctx);
