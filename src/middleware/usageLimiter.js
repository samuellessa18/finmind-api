'use strict';

// [CRÍTICO-3] Race condition corrigida: incremento atômico no PostgreSQL
// Padrão anterior: upsert (leitura) → check → update (escrita) = TOCTOU
// Padrão corrigido: upsert (garante linha) → UPDATE condicional atômico

const prisma = require('../../prisma/client');
const { trackTelemetry } = require('../services/telemetryService');

const usageLimiter = (feature = 'ai_insight') => {
  return async (req, res, next) => {
    try {
      const userId  = req.user.id;
      const userPlan = req.user.plan || 'free';

      const limits = { free: 3, pro: 50 };
      const userLimit = limits[userPlan] ?? limits.free;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Passo 1: Garantir que a linha existe (cria com count=0 se nova)
      // Sem race condition aqui: o upsert é idempotente — se dois requests
      // chegam juntos, ambos fazem upsert e garantem a linha com count=0.
      await prisma.aIUsage.upsert({
        where:  { userId_date: { userId, date: today } },
        update: {},
        create: { userId, date: today, count: 0 },
      });

      // Passo 2: Incremento atômico condicional via SQL raw
      // O UPDATE só acontece se count < userLimit — sem janela de race.
      // $executeRaw retorna o número de linhas afetadas (0 ou 1).
      const rowsAffected = await prisma.$executeRaw`
        UPDATE "AIUsage"
        SET    "count" = "count" + 1
        WHERE  "userId" = ${userId}
          AND  "date"   = ${today}
          AND  "count"  < ${userLimit}
      `;

      if (rowsAffected === 0) {
        // Limite atingido (count >= userLimit antes do incremento)
        await trackTelemetry(userId, 'usage_limit_reached', {
          plan: userPlan, feature, limit: userLimit,
        });

        return res.status(429).json({
          success: false,
          message: `Limite diário de ${feature} atingido para o plano ${userPlan.toUpperCase()}.`,
          code:    'USAGE_LIMIT_REACHED',
          limit:   userLimit,
        });
      }

      next();
    } catch (error) {
      console.error('[UsageLimiter Error]:', error.message);
      next(error);
    }
  };
};

module.exports = usageLimiter;
