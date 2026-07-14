'use strict';

// [Consultor · F4.8] Observabilidade e diagnóstico do pipeline do Consultor — 100% ADITIVO.
// Módulo autocontido: logger estruturado + registro de métricas + tracer (spans) + decoradores
// (provider/tools) prontos para o F5. NÃO altera nenhum contrato/regra de negócio; apenas observa.
//
// Capturável ADITIVAMENTE (sem tocar arquivos congelados):
//  - Fronteira HTTP (via middleware): requestId, conversationId, idempotencyKey, userId, turnId,
//    método/rota, status, latência/duração, error, resultado; contadores por status + turnos + turnos/min.
//  - Decoradores wrapProvider/wrapToolExecutor: tempo de provider e de tools — ATIVAM no F5 (provider
//    dormente hoje). Timings internos profundos (buildFinancialContext, tempo de SSE) exigiriam hooks
//    DENTRO do orchestrator congelado → deliberadamente NÃO instrumentados aqui (respeita o Freeze).

const crypto = require('crypto');

// Gate de LOG estruturado (as métricas em memória sempre acumulam — custo desprezível).
const obsLogEnabled = () => process.env.AI_CHAT_OBS_ENABLED === 'true';

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n); // ms monotônico
}

function classifyStatus(status) {
  if (status === 401) return 's401';
  if (status === 403) return 's403';
  if (status === 429) return 's429';
  if (status === 503) return 's503';
  if (status >= 500 && status < 600) return 's500';
  return 'ok';
}

function createChatObservability({ sink = console.log, clock = nowMs } = {}) {
  const counters = {
    turns_total: 0, // POST /conversations/turn observados
    create_total: 0, // POST /conversations
    consent_total: 0, // POST|DELETE /conversations/consent
    by_status: { s401: 0, s403: 0, s429: 0, s500: 0, s503: 0, ok: 0 },
    provider_error_total: 0,
    timeout_total: 0,
    retry_total: 0,
  };
  const turnTimestamps = []; // janela p/ turnos/min

  function turnsPerMin() {
    const cutoff = Date.now() - 60000;
    while (turnTimestamps.length && turnTimestamps[0] < cutoff) turnTimestamps.shift();
    return turnTimestamps.length;
  }

  function log(event, fields) {
    if (!obsLogEnabled()) return;
    try {
      sink(JSON.stringify({ ts: new Date().toISOString(), scope: 'chat_obs', event, ...fields }));
    } catch (_) {
      /* logging NUNCA quebra o pipeline */
    }
  }

  // tracer: um trace por request; spans por etapa (HTTP→Consent→...→SSE, quando instrumentado).
  function startTrace(ctx = {}) {
    const requestId = ctx.requestId || crypto.randomUUID();
    const t0 = clock();
    const fields = { requestId, ...ctx };
    const spans = {};
    return {
      requestId,
      setField(k, v) { fields[k] = v; },
      span(name) {
        const s0 = clock();
        return { end() { spans[name] = clock() - s0; } };
      },
      mark(name) { spans[name] = clock() - t0; },
      end(result = {}) {
        const durationMs = clock() - t0;
        const record = { ...fields, ...result, durationMs, spans };
        log('turn', record);
        return record;
      },
    };
  }

  // Decoradores prontos para o F5 (hoje o provider é dormente → wrapProvider(null) = null).
  function wrapProvider(provider, trace) {
    if (!provider) return provider;
    return {
      ...provider,
      async run(args) {
        const span = trace ? trace.span('provider') : null;
        try {
          return await provider.run(args);
        } catch (e) {
          counters.provider_error_total += 1;
          if (trace) trace.setField('providerError', true);
          throw e; // só observa e repropaga — NÃO altera comportamento
        } finally {
          if (span) span.end();
        }
      },
    };
  }

  function wrapToolExecutor(executor, trace) {
    if (typeof executor !== 'function') return executor;
    return async function observedToolExecutor(toolUse) {
      const span = trace ? trace.span(`tool:${toolUse && toolUse.name}`) : null;
      try {
        return await executor(toolUse);
      } finally {
        if (span) span.end();
      }
    };
  }

  // Incrementos usados pelo middleware HTTP.
  function recordHttp({ method, path, status }) {
    counters.by_status[classifyStatus(status)] += 1;
    if (/\/conversations\/turn$/.test(path) && method === 'POST') {
      counters.turns_total += 1;
      turnTimestamps.push(Date.now());
    } else if (/\/conversations$/.test(path) && method === 'POST') {
      counters.create_total += 1;
    } else if (/\/conversations\/consent$/.test(path)) {
      counters.consent_total += 1;
    }
  }
  function recordProviderError() { counters.provider_error_total += 1; }
  function recordTimeout() { counters.timeout_total += 1; }
  function recordRetry() { counters.retry_total += 1; }

  function snapshot() {
    return { ...counters, by_status: { ...counters.by_status }, turns_per_min: turnsPerMin() };
  }

  return {
    startTrace, wrapProvider, wrapToolExecutor,
    recordHttp, recordProviderError, recordTimeout, recordRetry,
    snapshot, log,
  };
}

// Singleton compartilhado (middleware + decoradores no F5 + eventual endpoint de leitura).
const chatObservability = createChatObservability();

module.exports = { createChatObservability, chatObservability, classifyStatus };
