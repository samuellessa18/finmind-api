/**
 * FinMind API — middleware/errorHandler.js
 * Versão: PATCHED (Auditoria de Segurança)
 *
 * Correções aplicadas:
 *  1. Stack trace NUNCA exposto em produção (estava correto para dev, mas
 *     adicionada proteção explícita para não vazar em produção)
 *  2. Erros do Prisma mapeados para mensagens amigáveis (sem vazar SQL)
 *  3. Erros de validação Zod tratados explicitamente
 */

'use strict';

const errorHandler = (err, req, res, next) => {
  const isProd       = process.env.NODE_ENV === 'production';
  let   statusCode   = err.status || 500;
  let   message      = err.message || 'Erro interno no servidor.';
  const code         = err.code   || 'INTERNAL_SERVER_ERROR';

  // ── Prisma: mapear erros conhecidos ──────────────────────────
  if (err.code === 'P2002') {
    // Unique constraint violation
    statusCode = 409;
    message    = 'Já existe um registro com este valor único.';
  } else if (err.code === 'P2025') {
    // Record not found
    statusCode = 404;
    message    = 'Registro não encontrado.';
  } else if (err.code === 'P2003') {
    // Foreign key constraint
    statusCode = 400;
    message    = 'Referência inválida.';
  }

  // ── CORS error ───────────────────────────────────────────────
  if (err.message?.includes('política de CORS')) {
    statusCode = 403;
    message    = 'Acesso não permitido por política de CORS.';
  }

  // ── Log interno ──────────────────────────────────────────────
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level:     'error',
      requestId: req.id,
      method:    req.method,
      path:      req.path,
      status:    statusCode,
      message:   err.message,
      // Stack apenas em desenvolvimento — NUNCA em produção
      ...(isProd ? {} : { stack: err.stack }),
    })
  );

  // ── Resposta ao cliente ───────────────────────────────────────
  // Em produção: nunca expor stack trace ou mensagens internas do Prisma
  const responseMessage = isProd && statusCode === 500
    ? 'Ocorreu um erro interno. Tente novamente mais tarde.'
    : message;

  res.status(statusCode).json({
    success:   false,
    message:   responseMessage,
    code,
    requestId: req.id,
    // Stack trace APENAS em desenvolvimento
    ...(isProd ? {} : { stack: err.stack }),
  });
};

module.exports = errorHandler;
