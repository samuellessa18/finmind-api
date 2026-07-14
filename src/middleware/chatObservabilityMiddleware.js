'use strict';

// [Consultor · F4.8] Middleware de observabilidade HTTP — 100% ADITIVO. Envolve as rotas do consultor
// (/api/v1/conversations/*) SEM alterar o router, o SSE ou os handlers:
//  - gera/propaga um requestId; abre um trace; captura conversationId/idempotencyKey do req.body;
//  - captura o CORPO da resposta JSON (turnId/error) interceptando res.json (delega ao original);
//  - no 'finish' mede latência, lê o status, captura userId (já populado pelo auth que rodou no router)
//    e emite log estruturado + incrementa métricas.
// Não toca SSE (que usa res.write/res.end, não res.json). Falha de log jamais afeta a resposta.
const crypto = require('crypto');

function chatObservabilityMiddleware(obs) {
  return function chatObs(req, res, next) {
    const requestId = req.header('x-request-id') || crypto.randomUUID();
    const path = req.originalUrl || req.url;
    const trace = obs.startTrace({
      requestId,
      method: req.method,
      path,
      conversationId: req.body && req.body.conversationId,
      idempotencyKey: req.body && req.body.idempotencyKey,
    });

    // Captura o corpo JSON da resposta sem alterar o comportamento (delega ao res.json original).
    const originalJson = res.json.bind(res);
    let responseBody;
    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };

    res.on('finish', () => {
      try {
        const status = res.statusCode;
        obs.recordHttp({ method: req.method, path, status });
        const errorCode = responseBody && responseBody.error;
        // 503 com error != chat_unavailable = indisponibilidade retryável (DISPATCH_LOST/ERROR/timeout).
        if (status === 503 && errorCode && errorCode !== 'chat_unavailable') obs.recordTimeout();
        trace.end({
          status,
          userId: req.user && req.user.id, // presente se o auth do router rodou antes do finish
          turnId: responseBody && responseBody.turnId,
          error: errorCode,
          result: errorCode || status >= 400 ? 'error' : 'ok',
        });
      } catch (_) {
        /* observabilidade nunca afeta a resposta */
      }
    });

    next();
  };
}

module.exports = { chatObservabilityMiddleware };
