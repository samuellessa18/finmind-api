'use strict';

// [Consultor · E2] requestHash canônico — Baseline v1.2 Apêndice A (RFC0004).
//   requestHash = "fmqh1:" + hex( SHA-256( "FMQH1" || 0x1F || conversationId || 0x1F || NFC(userMessage) ) )
// Determinístico inter-instância (Inv. global 35): mesma (conversationId, NFC(userMessage))
// → mesmo hash. Reuso da idempotencyKey com conteúdo diferente ⇒ hash diferente ⇒ conflito 409.

const crypto = require('crypto');

const PREFIX = 'fmqh1:';
const DOMAIN = Buffer.from('FMQH1', 'utf8');
const SEP = Buffer.from([0x1f]); // US (unit separator)

/**
 * @param {string} conversationId
 * @param {string} userMessage  texto bruto do usuário (será normalizado NFC)
 * @returns {string} "fmqh1:" + sha256hex
 */
function computeRequestHash(conversationId, userMessage) {
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    throw new Error('[requestHash] conversationId (string) obrigatório');
  }
  if (typeof userMessage !== 'string') {
    throw new Error('[requestHash] userMessage (string) obrigatório');
  }
  const payload = Buffer.concat([
    DOMAIN,
    SEP,
    Buffer.from(conversationId, 'utf8'),
    SEP,
    Buffer.from(userMessage.normalize('NFC'), 'utf8'),
  ]);
  return PREFIX + crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = { computeRequestHash, PREFIX };
