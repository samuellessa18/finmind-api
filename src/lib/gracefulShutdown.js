'use strict';

// [F0.2A] Sequência de shutdown TESTÁVEL (sem process.exit — o caller registra os sinais e sai).
// Ordem: parar agendamento → drenar jobs (crons) em voo → drenar HTTP (fecha ociosos já; força os
// sockets ativos/SSE após um grace curto para close() resolver dentro da janela) → fechar Prisma →
// flush Sentry. Cada passo é best-effort e isolado; nenhum passo derruba a sequência.

async function runShutdown(deps = {}) {
  const {
    httpServer = null,
    stopScheduling = null,   // () => void | Promise  : para node-cron/timers
    drainJobs = null,        // () => Promise         : espera jobs em voo (jobTracker.drainJobs)
    disconnectPrisma = null, // () => Promise
    flush = null,            // () => Promise         : flush do Sentry (no-op sem DSN)
    log = () => {},
    graceMs = 3000,
  } = deps;

  // 1) Parar de agendar novo trabalho (crons/timers).
  try { if (stopScheduling) await stopScheduling(); } catch (_) {}

  // 2) Drenar jobs (crons) em voo ANTES de mexer no banco (evita query concorrente com $disconnect).
  try { if (drainJobs) await drainJobs(); } catch (_) {}

  // 3) Drenar HTTP: fecha keep-alive ociosos imediatamente; se algum socket ativo (ex.: SSE longo)
  //    não terminar dentro do grace, força o fechamento — assim close() resolve sem depender do
  //    hard-timeout externo.
  if (httpServer) {
    try { if (typeof httpServer.closeIdleConnections === 'function') httpServer.closeIdleConnections(); } catch (_) {}
    const closed = new Promise((resolve) => {
      try { httpServer.close(() => resolve()); } catch (_) { resolve(); }
    });
    const forceSockets = setTimeout(() => {
      try { if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections(); } catch (_) {}
    }, graceMs);
    if (forceSockets && typeof forceSockets.unref === 'function') forceSockets.unref();
    await closed;
    clearTimeout(forceSockets);
    log('[shutdown] HTTP drenado.');
  }

  // 4) Fechar o pool do Prisma (agora sem requests nem crons em voo).
  try { if (disconnectPrisma) { await disconnectPrisma(); log('[shutdown] Prisma desconectado.'); } } catch (_) {}

  // 5) Flush do Sentry (no-op sem DSN).
  try { if (flush) await flush(); } catch (_) {}
}

module.exports = { runShutdown };
