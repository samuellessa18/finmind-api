'use strict';

// [Consultor · 1C] Rate-limit best-effort, em memória, POR-INSTÂNCIA (Apêndice D: Redis fora de escopo).
//   - Pré-gate ANTES do admitTurn: a request bloqueada NUNCA chega ao motor (C7-RL-PRECEDE-GUARD).
//   - NÃO é a fonte de verdade da cota — só o motor E2 é (C7-RL-NOT-SOURCE-OF-TRUTH). Nunca lê/escreve DB.
//   - Estado puramente em memória; some no restart (best-effort). Chave = userId autenticado.
//   - 429-rate-limit é DISTINTO de 429-quota (corpo `rate_limited` + Retry-After).
//   - Falha interna do limiter → fail-open por default (best-effort; não bloqueia nem toca o motor).

const cfg = require('../../config/chatOrchestratorConfig').rateLimit;

function createRateLimiter(opts = {}) {
  const windowMs = opts.windowMs != null ? opts.windowMs : cfg.windowMs;
  const maxInWindow = opts.maxInWindow != null ? opts.maxInWindow : cfg.maxInWindow;
  const failOpen = opts.failOpen != null ? opts.failOpen : cfg.failOpen;
  const buckets = new Map(); // userId -> { count, windowStart }

  // nowMs injetável p/ relógio controlável nos testes (janela ortogonal ao dayKey — C7-RL-WINDOW-RESET).
  function check(key, nowMs = Date.now()) {
    try {
      if (!key) return { allowed: failOpen, retryAfterMs: 0 };
      let b = buckets.get(key);
      if (!b || nowMs - b.windowStart >= windowMs) {
        b = { count: 0, windowStart: nowMs };
        buckets.set(key, b);
      }
      if (b.count < maxInWindow) {
        b.count += 1;
        return { allowed: true, retryAfterMs: 0 };
      }
      return { allowed: false, retryAfterMs: Math.max(0, b.windowStart + windowMs - nowMs) };
    } catch (_) {
      // falha do componente best-effort → política explícita (fail-open default), nunca toca o motor
      return { allowed: failOpen, retryAfterMs: 0 };
    }
  }

  return { check, _buckets: buckets };
}

module.exports = { createRateLimiter };
