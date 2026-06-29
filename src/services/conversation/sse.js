'use strict';

// [Consultor · 1C] Camada SSE (D1C-3). Wire-format CONGELADO: event nomeado ∈ {delta,heartbeat,done,error}.
//   - delta    {seq?,text}            — NÃO-autoritativo (preview); jamais decide estado/billing.
//   - heartbeat {}                    — keep-alive; NUNCA toca estado (não escreve no DB).
//   - done     {turnId,assistantMessageSeq,content}  — EXCLUSIVAMENTE esses 3 campos; confirma o que o
//                                         motor JÁ persistiu (billTurn). Emitido só com billed:true.
//   - error    {code,retryable}       — falha; nunca um done de sucesso.
//
// REGRA DURA (R1C-5): escrever em socket fechado/quebrado (EPIPE) NUNCA propaga erro ao orquestrador
// — falha de TRANSPORTE de um frame ≠ falha do turno. Toda escrita é best-effort (try/catch).

const cfg = require('../../config/chatOrchestratorConfig');
const EV = cfg.sse.events;

function frame(event, data) {
  return `event: ${event}\n` + `data: ${JSON.stringify(data === undefined ? {} : data)}\n\n`;
}

// SSE sobre um `res` do Express. Headers SSE são abertos PREGUIÇOSAMENTE na 1ª escrita — assim a rota
// só vira SSE no caminho ADMITTED→stream; outcomes não-streaming (LIMIT/CONFLICT/IN_FLIGHT/REPLAY/
// DISPATCH_LOST) retornam ANTES de qualquer escrita → `opened=false` → a rota responde JSON com o status.
// Erros de escrita (socket fechado) são engolidos (best-effort) — falha de transporte ≠ falha do turno.
function createHttpSse(res) {
  let opened = false;
  let writeFailed = false;
  function ensureOpen() {
    if (opened) return;
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    } catch (_) { writeFailed = true; }
    opened = true;
  }
  function write(event, data) {
    ensureOpen();
    try {
      res.write(frame(event, data));
    } catch (_) {
      writeFailed = true; // socket fechado/quebrado — engolido (transporte, não turno)
    }
  }
  return {
    delta: (text, seq) => write(EV.DELTA, seq === undefined ? { text } : { seq, text }),
    heartbeat: () => write(EV.HEARTBEAT, {}),
    done: ({ turnId, assistantMessageSeq, content }) => write(EV.DONE, { turnId, assistantMessageSeq, content }),
    error: ({ code, retryable }) => write(EV.ERROR, { code, retryable: !!retryable }),
    get opened() { return opened; },
    get writeFailed() { return writeFailed; },
  };
}

// Sink de gravação (testes): registra eventos em ORDEM monotônica para asserir bill-antes-de-done,
// supressão de done, deltas-não-autoritativos. Pode injetar uma falha de escrita por tipo de evento.
function createRecordingSink({ failOn = null } = {}) {
  const events = [];
  let order = 0;
  function rec(type, payload) {
    order += 1;
    if (failOn && failOn.has && failOn.has(type)) {
      // simula EPIPE só neste tipo de frame; NÃO propaga (igual ao HTTP best-effort)
      events.push({ type, payload, order, writeFailed: true });
      return;
    }
    events.push({ type, payload, order, writeFailed: false });
  }
  return {
    delta: (text, seq) => rec(EV.DELTA, seq === undefined ? { text } : { seq, text }),
    heartbeat: () => rec(EV.HEARTBEAT, {}),
    done: ({ turnId, assistantMessageSeq, content }) => rec(EV.DONE, { turnId, assistantMessageSeq, content }),
    error: ({ code, retryable }) => rec(EV.ERROR, { code, retryable: !!retryable }),
    events,
    ofType: (t) => events.filter((e) => e.type === t),
    has: (t) => events.some((e) => e.type === t),
  };
}

// SSE no-op (quando não há cliente streamando — ex.: chamada não-stream).
function createNullSse() {
  return { delta: () => {}, heartbeat: () => {}, done: () => {}, error: () => {} };
}

module.exports = { createHttpSse, createRecordingSink, createNullSse, frame, EV };
