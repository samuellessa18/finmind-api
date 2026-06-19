'use strict';

// [FASE 5.2] Observabilidade mínima da narração — SÓ MÉTRICAS.
// NUNCA registra context, valores financeiros, categorias ou qualquer PII.
// Emite uma linha JSON em stdout (capturada pelo Render), permitindo medir:
// custo (tokens), taxa de fallback (generatedBy/fallback_reason) e latência.

function logNarration(m) {
  try {
    console.log(JSON.stringify({
      evt: 'llm_narration',
      ts: new Date().toISOString(),
      generatedBy: m.generatedBy ?? null,
      provider: m.provider ?? null,
      model: m.model ?? null,
      duration_ms: typeof m.duration_ms === 'number' ? m.duration_ms : null,
      fallback_reason: m.fallback_reason ?? null,
      usage_input_tokens: m.usage ? (m.usage.input_tokens ?? null) : null,
      usage_output_tokens: m.usage ? (m.usage.output_tokens ?? null) : null,
    }));
  } catch (_) {
    /* observabilidade NUNCA quebra o fluxo de narração */
  }
}

// Classifica o erro do provider num motivo curto (sem vazar mensagem/PII).
function classifyFallbackReason(e) {
  if (!e) return 'unknown';
  const name = e.name || '';
  const code = e.code || '';
  const status = e.status;
  if (name === 'APITimeoutError' || code === 'ECONNABORTED') return 'timeout';
  if (status === 401 || name === 'AuthenticationError') return 'auth';
  if (status === 403 || name === 'PermissionDeniedError') return 'auth';
  if (status === 429 || name === 'RateLimitError') return 'quota';
  if (name === 'APIConnectionError' || code === 'ECONNRESET' || code === 'ECONNREFUSED') return 'network';
  if (e instanceof SyntaxError || /JSON|sem bloco de texto/i.test(e.message || '')) return 'parsing';
  if (/ANTHROPIC_API_KEY/i.test(e.message || '')) return 'no_key';
  return 'provider_error';
}

module.exports = { logNarration, classifyFallbackReason };
