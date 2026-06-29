'use strict';

// [Consultor · 1C] Orquestrador do turno — dirige as transições do motor E2 CONGELADO + provider.
//   "o motor calcula, a IA narra": delega 100% da contabilidade ao motor; não recomputa nada.
//
// Ordem (Baseline §2): [gates da rota] → reconcileUserLazy (D1C-5) → admitTurn → dispatchTurn →
//   conversate (I/O do provider, FORA de qualquer tx/lock) → billTurn → done.
//
// Decisões congeladas aplicadas:
//   D1C-1: MAX_TOOL_ITERATIONS estourado → refundTurn(ERROR), nunca cobra; evento + erro estruturado.
//   D1C-2: qualquer erro ANTES do bill definitivo → 503; cliente recupera via replay.
//   D1C-5: reconcileUserLazy imediatamente antes do admit; NUNCA bloqueia o fluxo se falhar.
//   D1C-6: tradução do usage (provider {input_tokens,output_tokens} → billTurn {input,output}); nunca NULL.
//   D1C-10: métricas (phantom_charge/replay_total/refund_total/provider_error_total) sem tocar a tx.
//
// INVARIANTE DE ATOMICIDADE: dispatchTurn (tx própria, commita e libera o lock) → conversate (SEM tx)
//   → billTurn (tx própria). NENHUM prisma.$transaction externo envolve o I/O do provider.

const { admitTurn, dispatchTurn, billTurn, refundTurn } = require('../chat/chatQuotaService');
const { reconcileUserLazy } = require('../chat/chatReconciliationService');
const { conversate } = require('./conversate');
const cfg = require('../../config/chatOrchestratorConfig');

// D1C-6: soma usage por round e traduz para o shape do billTurn; NUNCA retorna NULL.
function adaptUsage(usagePerRound) {
  let input = 0;
  let output = 0;
  for (const u of usagePerRound || []) {
    if (u) {
      input += Number(u.input_tokens) || 0;
      output += Number(u.output_tokens) || 0;
    }
  }
  return { input, output };
}

class TimeoutError extends Error {
  constructor() { super('conversate timeout'); this.name = 'TimeoutError'; }
}

// Timeout do provider via timer do Node (não há now() do Postgres para abortar I/O de rede).
// Abort best-effort + Promise.race. O refund é idempotente (CAS), então convergir com a janela
// de stale do Postgres (relógios distintos) não causa dupla devolução (R1C-15).
function withTimeout(promiseFactory, ms) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { if (ac) try { ac.abort(); } catch (_) {} reject(new TimeoutError()); }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([
    Promise.resolve().then(() => promiseFactory(ac ? ac.signal : null)),
    timeout,
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Executa um turno completo. `deps` injeta tudo (testável com stub/sink): prisma, provider,
 * toolExecutor, sse (delta/heartbeat/done/error), metrics, tools, nowIso.
 * Retorna { httpStatus, outcome, turn?, served?, content?, assistantMessageSeq? }.
 * Emite eventos SSE SOMENTE no caminho ADMITTED→stream; os demais outcomes são não-streaming
 * (a rota responde JSON com httpStatus).
 */
async function runTurn(deps, params) {
  const {
    prisma, provider, toolExecutor, metrics,
    sse = null, tools = [], nowIso = null,
    maxIterations = cfg.toolLoop.maxIterations,
    llmTimeoutMs = cfg.toolLoop.llmTimeoutMs,
  } = deps;
  const { userId, conversationId, idempotencyKey, userMessage, plan } = params;

  // D1C-5: reconciliação lazy imediatamente antes do admit; best-effort, NUNCA bloqueia o turno.
  try {
    await reconcileUserLazy(prisma, { userId, nowIso });
  } catch (_) { /* o cron é o backstop definitivo; lazy nunca derruba o turno corrente */ }

  // (1) Admissão — único ponto que consome cota. Trata os 5 outcomes do motor.
  const adm = await admitTurn(prisma, { userId, conversationId, idempotencyKey, userMessage, plan, nowIso });

  if (adm.outcome === 'LIMIT') return { httpStatus: 429, outcome: 'LIMIT', turn: null };
  if (adm.outcome === 'CONFLICT') return { httpStatus: 409, outcome: 'CONFLICT', turn: adm.turn };
  if (adm.outcome === 'IN_FLIGHT') {
    metrics && metrics.inc('replay_total');
    return { httpStatus: 202, outcome: 'IN_FLIGHT', turn: adm.turn }; // sem retomar o provider
  }
  if (adm.outcome === 'REPLAY') {
    metrics && metrics.inc('replay_total');
    const t = adm.turn;
    // R1C-7: terminal-refundante (REFUNDED/ERROR) tem billedAt NULL e NÃO tem assistant → nada a servir.
    if (t.billedAt) {
      const asst = await prisma.chatMessage.findFirst({
        where: { turnId: t.id, userId, role: 'assistant' }, orderBy: { seq: 'desc' },
      });
      return { httpStatus: 200, outcome: 'REPLAY', turn: t, served: true, assistantMessageSeq: asst ? asst.assistantMessageSeq : null, content: asst ? asst.content : null };
    }
    return { httpStatus: 200, outcome: 'REPLAY', turn: t, served: false, content: null }; // não reanima
  }

  // adm.outcome === 'ADMITTED' → dirigir o turno
  const turnId = adm.turn.id;

  // Seam de teste (inerte em produção; nenhum caller real passa _afterAdmit): permite injetar uma
  // transição REAL do turno entre admit e dispatch (ex.: refundTurn) p/ exercitar dispatched:false
  // pela mecânica REAL do CAS — sem mockar dispatchTurn (R1C-1).
  if (deps._afterAdmit) await deps._afterAdmit(adm.turn);

  // (2) ADMITTED → DISPATCHING. Só chama o provider se dispatched:true (corrida perdida ⇒ NÃO chama).
  const disp = await dispatchTurn(prisma, { turnId, userId, nowIso });
  if (!disp.dispatched) {
    return { httpStatus: 503, outcome: 'DISPATCH_LOST', turn: adm.turn }; // outro caminho transicionou
  }

  // (3) Tool loop / provider I/O — FORA de qualquer tx (lock já liberado no commit do dispatch).
  let conv;
  try {
    conv = await withTimeout(
      (signal) => conversate(provider, { userMessage, tools, toolExecutor, maxIterations, sse, signal }),
      llmTimeoutMs,
    );
  } catch (e) {
    // timeout ou erro do provider/loop (fan-in mismatch, stopReason inesperado) → ERROR (D1C-2)
    metrics && metrics.inc('provider_error_total');
    const ref = await refundTurn(prisma, { turnId, userId, terminal: 'ERROR', nowIso });
    if (ref.decremented) metrics && metrics.inc('refund_total');
    sse && sse.error({ code: e instanceof TimeoutError ? 'provider_timeout' : 'provider_error', retryable: true });
    return { httpStatus: 503, outcome: 'ERROR' };
  }

  // (3b) D1C-1: estourou MAX_TOOL_ITERATIONS → refundTurn(ERROR), NUNCA cobra.
  if (conv.stopReason === 'max_iterations') {
    metrics && metrics.inc('provider_error_total');
    const ref = await refundTurn(prisma, { turnId, userId, terminal: 'ERROR', nowIso });
    if (ref.decremented) metrics && metrics.inc('refund_total');
    sse && sse.error({ code: 'max_iterations_exceeded', retryable: false });
    return { httpStatus: 503, outcome: 'ERROR' };
  }

  // (4) D1C-6: traduz/soma o usage (nunca NULL).
  const usage = adaptUsage(conv.usagePerRound);

  // Seam de teste (inerte em produção): injeta transição REAL do turno entre conversate e bill
  // (ex.: reconciliação venceu → ERROR) p/ exercitar billed:false pela mecânica REAL do CAS.
  if (deps._beforeBill) await deps._beforeBill(turnId);

  // (5) DISPATCHING → BILLED (assistant write-once na mesma tx).
  const bill = await billTurn(prisma, { turnId, userId, assistantContent: conv.assistantContent || '', stopReason: 'end_turn', usage, nowIso });
  if (!bill.billed) {
    // corrida perdida (reconciliação venceu → ERROR). D1C-2: 503, NUNCA done de sucesso.
    // R1C-10: phantom_charge SOMENTE se o provider efetivamente consumiu (usage>0).
    if (usage.input > 0 || usage.output > 0) metrics && metrics.inc('phantom_charge');
    sse && sse.error({ code: 'turn_reconciled_during_dispatch', retryable: true });
    return { httpStatus: 503, outcome: 'BILLED_FALSE' };
  }

  // (6) BILLED persistido → SÓ AGORA o `done` (confirma o que o motor já gravou).
  const asst = await prisma.chatMessage.findFirst({
    where: { turnId, userId, role: 'assistant' }, orderBy: { seq: 'desc' },
  });
  const assistantMessageSeq = asst ? asst.assistantMessageSeq : null;
  sse && sse.done({ turnId, assistantMessageSeq, content: conv.assistantContent || '' });
  const turn = await prisma.chatTurn.findFirst({ where: { id: turnId, userId } });
  return { httpStatus: 200, outcome: 'BILLED', turn, assistantMessageSeq, content: conv.assistantContent || '' };
}

module.exports = { runTurn, adaptUsage, TimeoutError, withTimeout };
