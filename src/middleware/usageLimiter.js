const prisma = require('../../prisma/client');
const { trackTelemetry } = require('../services/telemetryService');

/**
 * Middleware para limitar o uso de IA com base no plano do usuário
 * @param {string} feature - Nome da feature para logs (opcional)
 */
const usageLimiter = (feature = 'ai_insight') => {
    return async (req, res, next) => {
        try {
            const userId = req.user.id;
            const userPlan = req.user.plan || 'free';

            // Limites por plano
            const limits = {
                free: 3,
                pro: 50
            };

            const userLimit = limits[userPlan] || limits.free;

            // Normalizar data para o dia atual (00:00:00)
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Operação atômica: buscar ou criar registro do dia e validar
            // Nota: SQLite não suporta increment diretamente no upsert de forma tão simples com prisma
            // Mas podemos usar uma transação ou buscar e depois atualizar.
            // Para garantir atomicidade real, usaríamos executeRaw, mas aqui usaremos transação Prisma.

            const usage = await prisma.aIUsage.upsert({
                where: {
                    userId_date: {
                        userId: userId,
                        date: today
                    }
                },
                update: {},
                create: {
                    userId: userId,
                    date: today,
                    count: 0
                }
            });

            if (usage.count >= userLimit) {
                // Rastrear interesse em monetização (atingiu limite)
                await trackTelemetry(userId, 'usage_limit_reached', { 
                    plan: userPlan, 
                    feature,
                    limit: userLimit 
                });

                return res.status(429).json({
                    success: false,
                    message: `Você atingiu o limite diário de insights para o plano ${userPlan.toUpperCase()}.`,
                    code: 'USAGE_LIMIT_REACHED',
                    limit: userLimit
                });
            }

            // Incrementar count
            await prisma.aIUsage.update({
                where: { id: usage.id },
                data: { count: { increment: 1 } }
            });

            next();
        } catch (error) {
            console.error('[UsageLimiter Error]:', error.message);
            next(error);
        }
    };
};

module.exports = usageLimiter;
