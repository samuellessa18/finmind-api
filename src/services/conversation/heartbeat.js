'use strict';

// [Consultor · 1D] Agendador de heartbeat SSE (D1D-7). Wrapper aditivo de TRANSPORTE — não muda
// contrato da 1C. Guard isOpen (R-HEARTBEAT-OPEN-GUARD): só emite DEPOIS que o stream já foi aberto
// por um delta/done/error real — nunca abre headers prematuramente (preserva os outcomes JSON).
// timer.unref() (não segura o processo) + stop() idempotente chamado no finally do handler.

function startHeartbeat(sse, intervalMs, { isOpen } = {}) {
  const open = typeof isOpen === 'function' ? isOpen : () => true;
  const timer = setInterval(() => {
    try { if (open() && sse && typeof sse.heartbeat === 'function') sse.heartbeat(); } catch (_) { /* best-effort */ }
  }, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  let stopped = false;
  return {
    stop() { if (stopped) return; stopped = true; clearInterval(timer); },
  };
}

module.exports = { startHeartbeat };
