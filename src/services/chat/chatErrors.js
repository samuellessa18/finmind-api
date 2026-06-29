'use strict';

// [Consultor · E2] Taxonomia de erros + retry de serialização/deadlock — Baseline §4 / D4.

class ChatValidationError extends Error {
  constructor(message) { super(message); this.name = 'ChatValidationError'; this.httpStatus = 400; }
}
class QuotaLimitError extends Error {
  constructor() { super('quota diária esgotada'); this.name = 'QuotaLimitError'; this.httpStatus = 429; }
}

// Resultados possíveis da admissão (e replay).
const OUTCOME = Object.freeze({
  ADMITTED: 'ADMITTED',     // 201
  REPLAY: 'REPLAY',         // 200 — turno terminal servido idempotente
  IN_FLIGHT: 'IN_FLIGHT',   // 202 — turno {ADMITTED,DISPATCHING} em voo
  CONFLICT: 'CONFLICT',     // 409 (config) — mesma idempotencyKey, requestHash diferente
  LIMIT: 'LIMIT',           // 429 — cota estourada
});

/**
 * Extrai o SQLSTATE do Postgres de um erro do Prisma (typed ou raw).
 * - findUnique/create unique violation → Prisma 'P2002' (mapeado p/ 23505)
 * - $executeRaw/$queryRaw → PrismaClientKnownRequestError 'P2010' c/ meta.code = SQLSTATE
 */
function pgState(e) {
  if (!e) return null;
  if (e.code === 'P2002') return '23505';
  const metaCode = e.meta && (e.meta.code || (e.meta.dbError && e.meta.dbError.code));
  if (metaCode) return String(metaCode);
  const m = /\b(40001|40P01|23505|23514|22P05|55P03|23503|23502)\b/.exec(e.message || '');
  if (m) return m[1];
  return e.code || null;
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Reexecuta `fn` em 40001/40P01 com backoff curto. Esgotados os retries, RELANÇA
 * (o chamador mapeia para 503 — D4). Conta as tentativas em onRetry (observabilidade/perf).
 */
async function withRetry(fn, { retries = 5, baseMs = 5, onRetry = null } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const st = pgState(e);
      if (RETRYABLE.has(st) && attempt < retries) {
        if (onRetry) onRetry(st, attempt + 1);
        await sleep(baseMs * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

/** Mapeia um erro de E2 para status HTTP (D4: 40001/40P01 esgotados → 503). */
function httpStatusForError(e) {
  if (e instanceof ChatValidationError) return 400;
  if (e instanceof QuotaLimitError) return 429;
  const st = pgState(e);
  if (st === '23505') return 409;          // unique não absorvido (caso raro)
  if (RETRYABLE.has(st)) return 503;       // serialization/deadlock esgotado
  return 503;                              // qualquer falha de DB → 503
}

module.exports = {
  ChatValidationError, QuotaLimitError, OUTCOME,
  pgState, withRetry, httpStatusForError, RETRYABLE,
};
