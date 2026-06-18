'use strict';

const prisma = require('../../prisma/client');

// [PADRÕES] Consulta read-only dos alertas de PADRÃO comportamental detectados.
// Reusa a tabela PatternAlert; filtra source='PATTERN' (NÃO expõe alertas de
// orçamento, source='BUDGET'); janela dos últimos `days` dias (default 90);
// mais recentes primeiro. Não escreve nada — não toca cron/detector/migrations.
async function listPatterns(userId, now = new Date(), days = 90) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return prisma.patternAlert.findMany({
    where: { userId, source: 'PATTERN', detectedAt: { gte: since } },
    orderBy: { detectedAt: 'desc' },
    select: { category: true, severity: true, percentage: true, detectedAt: true, message: true },
  });
}

module.exports = { listPatterns };
