'use strict';

// [F0.2A] Rastreamento de jobs (crons) em voo, para o graceful shutdown não concorrer com
// prisma.$disconnect(). guardedJob(fn): (a) NÃO inicia um novo lote se já estamos em shutdown;
// (b) contabiliza enquanto executa. drainJobs() espera (bounded) os jobs em voo terminarem antes
// de fechar o pool. task.stop() do node-cron só barra o PRÓXIMO tick — este módulo cobre o atual.

let active = 0;
let shuttingDown = false;

function beginShutdown() { shuttingDown = true; }
function isShuttingDown() { return shuttingDown; }
function activeJobs() { return active; }

// Envolve o callback de um cron/timer. Durante o shutdown, novos lotes não iniciam (return undefined).
function guardedJob(fn) {
  return async function guarded(...args) {
    if (shuttingDown) return undefined;
    active += 1;
    try {
      return await fn(...args);
    } finally {
      active -= 1;
    }
  };
}

// Espera os jobs em voo terminarem, até timeoutMs. Resolve true se drenou, false se estourou o tempo.
async function drainJobs(timeoutMs = 4000, pollMs = 50) {
  const start = Date.now();
  while (active > 0 && (Date.now() - start) < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return active === 0;
}

// Somente para teste: reseta o estado do módulo.
function _reset() { active = 0; shuttingDown = false; }

module.exports = { guardedJob, drainJobs, beginShutdown, isShuttingDown, activeJobs, _reset };
