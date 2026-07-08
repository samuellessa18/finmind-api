'use strict';

// [Consultor · 1C] Rota POST /api/v1/conversations/turn — adaptador HTTP fino sobre o orquestrador.
// Pilha (Baseline §2): auth → Zod(D1C-8) → posse 404(D1C-4) → rate-limit 429 → consent 403(D1C-7)
//   → runTurn (lazy reconcile + admit + dispatch + conversate + bill). SSE no caminho ADMITTED;
//   JSON com status nos demais outcomes (decisão pós-admit, antes de abrir o stream).
//
// Tudo INJETÁVEL (testável): prisma, rateLimiter, metrics, buildProvider, buildToolExecutor.
// O provider real de chat é DORMENTE/gated (LGPD): se indisponível → 503 ANTES de consumir cota.

const { z } = require('zod');
const { authenticateToken } = require('../middleware/auth');
const { findOwnedConversation } = require('../services/conversation/ownership');
const { hasChatConsent } = require('../services/conversation/consentGate');
const { runTurn } = require('../services/conversation/orchestrator');
const { createHttpSse } = require('../services/conversation/sse');
const { startHeartbeat } = require('../services/conversation/heartbeat');
const orchestratorConfig = require('../config/chatOrchestratorConfig');
const { httpStatusForError } = require('../services/chat/chatErrors');
const { grantChatConsent, revokeChatConsent } = require('../services/conversation/consentService');

const turnSchema = z.object({
  conversationId: z.string().min(1).max(64),
  userMessage: z.string().min(1),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), // D1C-8 / Baseline §1
});

// D1C-6/herdado #2: plano SEMPRE do usuário autenticado, NUNCA do body/header.
function derivePlan(user) {
  return (user && (user.plan === 'pro' || user.isPremium === true)) ? 'pro' : 'free';
}

function bodyForResult(r) {
  switch (r.outcome) {
    case 'REPLAY':
      return r.served
        ? { turnId: r.turn.id, assistantMessageSeq: r.assistantMessageSeq, content: r.content }
        : { turnId: r.turn.id, status: 'terminated', content: null }; // terminal-refundante: nada a servir
    case 'IN_FLIGHT': return { turnId: r.turn.id, status: 'in_flight' };
    case 'CONFLICT': return { error: 'idempotency_key_conflict' };
    case 'LIMIT': return { error: 'quota_exceeded' };
    case 'DISPATCH_LOST': return { error: 'unavailable', retryable: true };
    case 'ERROR':
    case 'BILLED_FALSE': return { error: 'unavailable', retryable: true };
    case 'BILLED': return { turnId: r.turn.id, assistantMessageSeq: r.assistantMessageSeq, content: r.content };
    default: return { error: 'unavailable' };
  }
}

// Handler do turno (sem auth) — exportado para teste com mock req/res (req.user já populado).
function makeTurnHandler(deps) {
  const {
    prisma, rateLimiter, metrics, buildProvider, buildToolExecutor, tools = [],
    heartbeatMs = orchestratorConfig.sse.heartbeatMs, // D1D-7: intervalo do keep-alive (fonte única; injetável p/ teste)
  } = deps;
  return async function turnHandler(req, res, next) {
    try {
      const userId = req.user.id;
      const plan = derivePlan(req.user);

      // D1C-8: validação Zod de toda entrada (idempotencyKey obrigatória + formato).
      const parsed = turnSchema.safeParse(req.body || {});
      if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
      const { conversationId, userMessage, idempotencyKey } = parsed.data;

      // D1C-4: posse antes do guard; recurso alheio/inexistente → 404 (unificado, não vaza existência).
      const conv = await findOwnedConversation(prisma, { conversationId, userId });
      if (!conv) return res.status(404).json({ error: 'not_found' });

      // Rate-limit best-effort ANTES do guard; 429-rate distinto de 429-quota.
      if (rateLimiter) {
        const rl = rateLimiter.check(userId);
        if (!rl.allowed) {
          res.set('Retry-After', String(Math.ceil((rl.retryAfterMs || 0) / 1000)));
          return res.status(429).json({ error: 'rate_limited', retryable: true });
        }
      }

      // D1C-7: consent LGPD antes do guard.
      if (!(await hasChatConsent(prisma, userId))) return res.status(403).json({ error: 'consent_required' });

      // Provider de chat DORMENTE/gated (LGPD): indisponível → 503 SEM consumir cota.
      const provider = buildProvider ? buildProvider(req.user) : null;
      if (!provider) return res.status(503).json({ error: 'chat_unavailable' });
      const toolExecutor = buildToolExecutor ? buildToolExecutor(req.user) : null;

      const sse = createHttpSse(res);
      // D1D-7: keep-alive de TRANSPORTE. Guard isOpen → só emite DEPOIS que o stream abriu por um frame
      // real (delta/done/error); em outcomes não-streaming (LIMIT/CONFLICT/...) sse.opened=false e o
      // heartbeat NUNCA escreve → preserva a resposta JSON+status. Timer unref'd; stop() no finally.
      const heartbeat = startHeartbeat(sse, heartbeatMs, { isOpen: () => sse.opened });
      let result;
      try {
        result = await runTurn(
          { prisma, provider, toolExecutor, metrics, sse, tools },
          { userId, conversationId, idempotencyKey, userMessage, plan },
        );
      } finally {
        heartbeat.stop();
      }

      if (sse.opened) return res.end(); // stream ADMITTED: deltas + done/error já emitidos
      return res.status(result.httpStatus).json(bodyForResult(result));
    } catch (e) {
      // Erro de DB propagado pelo motor (ex.: 40001/40P01 esgotado) → mapeia via E2.
      const status = httpStatusForError(e);
      if (res.headersSent) { try { res.end(); } catch (_) {} return undefined; }
      return res.status(status).json({ error: 'unavailable', retryable: status === 503 });
    }
  };
}

// [Consultor · G1] Handlers de consent ai_chat (grant/revoke). Escopo SEMPRE por req.user.id (D1C-6),
// NUNCA por body. consentGate permanece read-only; a escrita vive em consentService (find-guard/updateMany).
function makeConsentGrantHandler(deps) {
  const { prisma } = deps;
  return async function consentGrantHandler(req, res, next) {
    try {
      await grantChatConsent(prisma, req.user.id); // req.user.id do token; body ignorado
      return res.status(200).json({ scope: 'ai_chat', status: 'granted' });
    } catch (e) { return next(e); }
  };
}

function makeConsentRevokeHandler(deps) {
  const { prisma } = deps;
  return async function consentRevokeHandler(req, res, next) {
    try {
      await revokeChatConsent(prisma, req.user.id);
      return res.status(200).json({ scope: 'ai_chat', status: 'revoked' });
    } catch (e) { return next(e); }
  };
}

// [Consultor · F0] Criação de conversa — endpoint dedicado (Alt. B aprovada; criação implícita no /turn
// foi descartada). SÓ cria a ChatConversation do usuário autenticado: NÃO cria turn/mensagem, NÃO chama
// LLM/tools/provider, NÃO gera SSE, NÃO consome cota. Escopo SEMPRE por req.user.id (tenant isolation);
// body ignorado (title nasce null). Não toca /turn, turnSchema, runTurn, SSE nem o motor.
function makeCreateConversationHandler(deps) {
  const { prisma } = deps;
  return async function createConversationHandler(req, res, next) {
    try {
      const conv = await prisma.chatConversation.create({
        data: { userId: req.user.id }, // id=cuid, createdAt=now, updatedAt auto, title=null, archivedAt=null
        select: { id: true, createdAt: true, title: true },
      });
      return res.status(201).json({ conversationId: conv.id, createdAt: conv.createdAt, title: conv.title });
    } catch (e) { return next(e); }
  };
}

function createConversationRouter(deps) {
  const express = require('express');
  const router = express.Router();
  router.post('/conversations/turn', authenticateToken, makeTurnHandler(deps));
  // [Consultor · G1] Consent ai_chat — aditivo; linha do /turn intocada. Escopo por req.user.id.
  router.post('/conversations/consent', authenticateToken, makeConsentGrantHandler(deps));
  router.delete('/conversations/consent', authenticateToken, makeConsentRevokeHandler(deps));
  // [Consultor · F0] Criação de conversa — aditivo; /turn e /consent intocados. Rota distinta (/conversations).
  router.post('/conversations', authenticateToken, makeCreateConversationHandler(deps));
  return router;
}

module.exports = {
  createConversationRouter, makeTurnHandler, makeConsentGrantHandler, makeConsentRevokeHandler,
  makeCreateConversationHandler,
  turnSchema, derivePlan, bodyForResult,
};
