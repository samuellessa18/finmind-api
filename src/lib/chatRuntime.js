'use strict';

// [Consultor Financeiro IA · Pré-fase] Verificação de runtime: TZ=UTC no boot.
// Fonte: baseline-v1.2.md (RFC0003 §1.7 / RFC0004 invariante 39).
//
// O `dayKey` do chat é UTC por construção (toISOString().slice(0,10)) — então a
// correção de cota independe do TZ do processo. Esta verificação é DIAGNÓSTICA:
// captura drift de configuração (o legado usageLimiter usa setHours local) e garante
// que produção rode em UTC. Por padrão é não-fatal (warn); em produção pode falhar-rápido
// via AI_CHAT_REQUIRE_UTC=true para não subir um nó fora de UTC.

/** @returns {{ ok: boolean, offsetMinutes: number }} */
function checkUtcRuntime() {
  const offsetMinutes = new Date().getTimezoneOffset(); // 0 ⟺ UTC
  return { ok: offsetMinutes === 0, offsetMinutes };
}

/**
 * Verifica TZ=UTC no boot. Loga aviso se não-UTC; lança se exigido explicitamente
 * (AI_CHAT_REQUIRE_UTC=true ou NODE_ENV=production com a flag).
 * @param {{ logger?: { warn: Function }, requireUtc?: boolean }} [opts]
 */
function assertUtcRuntime(opts = {}) {
  const { ok, offsetMinutes } = checkUtcRuntime();
  if (ok) return true;

  const requireUtc = opts.requireUtc ?? (process.env.AI_CHAT_REQUIRE_UTC === 'true');
  const msg = `[chatRuntime] TZ NÃO é UTC (offset=${offsetMinutes}min). ` +
    `O Consultor exige TZ=UTC em produção (dayKey/quota). Configure TZ=UTC nas instâncias.`;

  if (requireUtc) throw new Error(msg);
  (opts.logger || console).warn(msg);
  return false;
}

module.exports = { checkUtcRuntime, assertUtcRuntime };
