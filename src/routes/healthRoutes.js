'use strict';

// [F0.2A] Health router testável: /live (liveness, ZERO dependências) + /ready (readiness:
// conexão + migrations compatíveis). Substitui os handlers inline da F0, agora exercitáveis
// por teste automatizado. O legado /api/health permanece em server.js (fora de escopo).

const {
  readExpectedMigrations, readAppliedMigrations, migrationStatus, DEFAULT_MIGRATIONS_DIR,
} = require('../lib/migrationCheck');

// Rejeita se a promise não resolver dentro de ms (fail-closed rápido se o pool travar).
function withTimeout(promise, ms) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('ready_timeout')), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function createHealthRouter({ prisma, migrationsDir = DEFAULT_MIGRATIONS_DIR, readyTimeoutMs = 2500 } = {}) {
  const express = require('express');
  const router = express.Router();
  const expected = readExpectedMigrations(migrationsDir); // fixado no boot; null = catálogo ilegível

  // Liveness — o processo está vivo? Sem DB, sem OpenAI/Anthropic, sem I/O.
  router.get('/live', (req, res) => {
    res.status(200).json({ status: 'ok', check: 'liveness', timestamp: new Date().toISOString() });
  });

  // Readiness — apto a servir? Conexão válida E migrations compatíveis (AF-1.0). JAMAIS terceiros.
  router.get('/ready', async (req, res) => {
    // Catálogo de migrations ilegível no boot (dir ausente) → não dá para afirmar compatibilidade →
    // fail-closed (nunca reportar "ready" sem conseguir verificar o esperado).
    if (expected === null) {
      console.error('[health/ready] catálogo de migrations ilegível (prisma/migrations ausente)');
      return res.status(503).json({
        status: 'not_ready',
        checks: { migrations: 'unverifiable' },
        timestamp: new Date().toISOString(),
      });
    }
    try {
      const applied = await withTimeout(readAppliedMigrations(prisma), readyTimeoutMs); // conexão + ledger
      const mig = migrationStatus(applied, expected);
      if (!mig.ok) {
        console.error('[health/ready] migrations incompatíveis; ausentes/pendentes:', mig.missing.slice(0, 5));
        return res.status(503).json({
          status: 'not_ready',
          checks: { database: 'connected', migrations: 'incompatible' },
          missing: mig.missing.slice(0, 10),
          timestamp: new Date().toISOString(),
        });
      }
      return res.status(200).json({
        status: 'ready',
        checks: { database: 'connected', migrations: 'ok' },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[health/ready] check falhou:', err && (err.code || err.message));
      return res.status(503).json({
        status: 'not_ready',
        checks: { database: 'error' },
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}

module.exports = { createHealthRouter };
