'use strict';

// [ALTO-4] LGPD — remover PII da telemetria antes de persistir
// Art. 6 da LGPD: minimização de dados — não coletar mais do que o necessário.

const prisma = require('../../prisma/client');

// Campos que NÃO devem ir para a tabela Event
const PII_FIELDS = ['email', 'password', 'name', 'phone', 'cpf', 'ip'];

function scrubPII(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = { ...obj };
  for (const field of PII_FIELDS) {
    if (field in clean) {
      delete clean[field];
    }
  }
  return clean;
}

async function trackTelemetry(userId, type, metadata = {}) {
  try {
    const safeMetadata = scrubPII(metadata);
    await prisma.event.create({
      data: {
        userId,
        type,
        metadata: safeMetadata && Object.keys(safeMetadata).length > 0
          ? JSON.stringify(safeMetadata)
          : null,
      },
    });
  } catch (error) {
    console.error(`[Telemetry Error] Failed to track ${type}:`, error.message);
  }
}

module.exports = { trackTelemetry };
