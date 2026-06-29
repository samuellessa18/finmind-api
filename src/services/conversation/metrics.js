'use strict';

// [Consultor · 1C] Observabilidade mínima (D1C-10) — contadores em memória, ZERO impacto na
// transação principal (nunca tocam o DB; nunca lançam para o caminho do turno).
// Métricas exigidas: phantom_charge, drift_nonzero, replay_total, refund_total, provider_error_total.
//
// Padrão "narrationLog" (Baseline §11): sem PII. Um sink injetável permite asserir emissões nos
// testes sem acoplar a um backend de métricas concreto (Prometheus/etc. ficam para o deploy).

const METRIC_NAMES = Object.freeze([
  'phantom_charge',
  'drift_nonzero',
  'replay_total',
  'refund_total',
  'provider_error_total',
]);

function createMetrics(sink = null) {
  const counters = Object.create(null);
  for (const n of METRIC_NAMES) counters[n] = 0;

  function inc(name, labels = {}) {
    if (!(name in counters)) return; // ignora métricas desconhecidas (defensivo; nunca lança)
    counters[name] += 1;
    if (sink && typeof sink.inc === 'function') {
      try { sink.inc(name, labels); } catch (_) { /* observabilidade NUNCA quebra o turno */ }
    }
  }

  return {
    inc,
    snapshot() { return { ...counters }; },
    names: METRIC_NAMES,
  };
}

// Singleton de processo (produção). Os testes criam instâncias isoladas via createMetrics().
const defaultMetrics = createMetrics();

module.exports = { createMetrics, defaultMetrics, METRIC_NAMES };
