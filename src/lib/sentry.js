'use strict';

// [FASE 4] Sentry — observabilidade e captura de erros.
//
// Design defensivo:
//   - Sem SENTRY_DSN configurado, init faz no-op gracioso (log e segue).
//   - Sem performance monitoring (tracesSampleRate=0) — overhead zero por request.
//   - PII scrubbing em todos os eventos via beforeSend e beforeBreadcrumb.
//   - userId nunca exposto em texto plano: hash HMAC-SHA256 → 8 chars.
//   - IP anonimizado (mesmo padrão do requestLogger).
//
// Reutiliza a lista PII do telemetryService para coerência LGPD.

const Sentry = require('@sentry/node');
const crypto = require('crypto');

const PII_FIELDS = ['email', 'password', 'name', 'phone', 'cpf', 'ip', 'token', 'jwt', 'authorization'];

let initialized = false;

function anonymizeIP(ip) {
  if (!ip) return undefined;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/\.\d+$/, '.0');
  const v4m = ip.match(/^::ffff:(\d+\.\d+\.\d+)\.\d+$/i);
  if (v4m) return `::ffff:${v4m[1]}.0`;
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::/48';
  return undefined;
}

function hashUserId(id) {
  if (!id) return undefined;
  const salt = process.env.JWT_SECRET || 'finmind-default-salt';
  return crypto.createHmac('sha256', salt).update(String(id)).digest('hex').slice(0, 8);
}

// Remove campos PII recursivamente (profundidade limitada para evitar loops/perf)
function scrub(obj, depth = 0) {
  if (depth > 4 || !obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PII_FIELDS.includes(k.toLowerCase())) {
      out[k] = '[scrubbed]';
    } else {
      out[k] = scrub(v, depth + 1);
    }
  }
  return out;
}

function beforeSend(event) {
  try {
    // Request: limpar headers sensíveis e cookies
    if (event.request) {
      if (event.request.headers) {
        const h = { ...event.request.headers };
        delete h.authorization; delete h.Authorization;
        delete h.cookie; delete h.Cookie;
        event.request.headers = h;
      }
      delete event.request.cookies;
      // Anonimiza IP se presente
      if (event.request.env && event.request.env.REMOTE_ADDR) {
        event.request.env.REMOTE_ADDR = anonymizeIP(event.request.env.REMOTE_ADDR);
      }
      // Body scrubbing
      if (event.request.data && typeof event.request.data === 'object') {
        event.request.data = scrub(event.request.data);
      }
    }
    // User: nunca enviar email/ip, só id hashed (já feito ao chamar setUser)
    if (event.user) {
      delete event.user.email;
      delete event.user.ip_address;
      delete event.user.username;
    }
    // Extra / contexts
    if (event.extra) event.extra = scrub(event.extra);
    if (event.contexts) event.contexts = scrub(event.contexts);
    // Tags: garantir que userId nunca apareça raw
    if (event.tags && event.tags.userId) {
      event.tags.userId = hashUserId(event.tags.userId);
    }
  } catch {
    // Nunca falhar dentro de beforeSend
  }
  return event;
}

function beforeBreadcrumb(breadcrumb) {
  try {
    if (breadcrumb.data) breadcrumb.data = scrub(breadcrumb.data);
    // Console breadcrumbs podem ter mensagens com PII — truncar
    if (breadcrumb.category === 'console' && breadcrumb.message && breadcrumb.message.length > 500) {
      breadcrumb.message = breadcrumb.message.slice(0, 500) + '…';
    }
  } catch {}
  return breadcrumb;
}

/**
 * Inicializa Sentry. No-op gracioso se SENTRY_DSN ausente.
 */
function initSentry() {
  if (initialized) return false;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[Sentry] SENTRY_DSN não configurado — observability OFF (deploy continua normal).');
    return false;
  }
  try {
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      release:     process.env.SENTRY_RELEASE || undefined,
      tracesSampleRate: 0,
      // Importante: não enviar PII automaticamente
      sendDefaultPii: false,
      beforeSend,
      beforeBreadcrumb,
      // Ignorar erros conhecidos de fluxo normal
      ignoreErrors: [
        // Auth: 401/403 fazem parte do fluxo normal
        'TokenExpiredError',
        'JsonWebTokenError',
      ],
    });
    initialized = true;
    console.log(`[Sentry] Inicializado (env=${Sentry.getCurrentHub().getClient()?.getOptions()?.environment}).`);
    return true;
  } catch (err) {
    console.error('[Sentry] Falha na inicialização — observability OFF:', err.message);
    return false;
  }
}

/**
 * Captura exception manualmente. Aceita opções com tags e extras.
 * No-op se Sentry não inicializado.
 */
function captureException(err, options = {}) {
  if (!initialized) return;
  try {
    Sentry.withScope((scope) => {
      if (options.userId) scope.setTag('userId', hashUserId(options.userId));
      if (options.requestId) scope.setTag('requestId', options.requestId);
      if (options.tags) for (const [k, v] of Object.entries(options.tags)) scope.setTag(k, String(v));
      if (options.extras) for (const [k, v] of Object.entries(options.extras)) scope.setExtra(k, scrub(v));
      Sentry.captureException(err);
    });
  } catch {}
}

/**
 * Executa uma função de cron com captura automática. Re-lança erro
 * para preservar comportamento original do try/catch chamador.
 */
async function wrapCron(jobName, fn) {
  try {
    return await fn();
  } catch (err) {
    captureException(err, { tags: { cron: jobName } });
    throw err;
  }
}

/**
 * Flush em casos terminais (uncaughtException, SIGTERM).
 * Timeout limita o tempo de espera para não bloquear shutdown.
 */
async function flush(timeoutMs = 2000) {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {}
}

module.exports = {
  initSentry,
  captureException,
  wrapCron,
  flush,
  // Re-export para middlewares Express
  Handlers: Sentry.Handlers,
  // Util exposed para testes
  _internal: { hashUserId, anonymizeIP, scrub },
};
