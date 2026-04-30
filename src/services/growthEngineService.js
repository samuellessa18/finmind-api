const prisma = require('../../prisma/client');
const { trackTelemetry } = require('./telemetryService');
const crypto = require('crypto');

const ROLLOUT_PERCENTAGE = parseInt(process.env.GROWTH_ROLLOUT_PERCENTAGE || '0');
const GLOBAL_COOLDOWN_HOURS = 72;
const MAX_ACTIONS_PER_DAY = 2;
const BATCH_SIZE = 50;

/**
 * Deterministic Rollout check using user ID
 */
const isInRollout = (userId) => {
    if (ROLLOUT_PERCENTAGE === 100) return true;
    if (ROLLOUT_PERCENTAGE === 0) return false;
    
    const hash = crypto.createHash('md5').update(userId).digest('hex');
    const hashInt = parseInt(hash.substring(0, 8), 16);
    return (hashInt % 100) < ROLLOUT_PERCENTAGE;
};

/**
 * Growth Rules Phase 12.1
 */
const GROWTH_RULES = [
    {
        key: 'low_activation',
        type: 'onboarding_tour',
        channel: 'notification',
        priority: 1,
        active: true, // Active for real users in rollout
        condition: async (user) => {
            const hasTransactions = await prisma.transaction.count({ where: { userId: user.id } });
            const hoursSinceCreated = (new Date() - new Date(user.createdAt)) / (1000 * 60 * 60);
            return hasTransactions === 0 && hoursSinceCreated >= 12;
        },
        payload: {
            title: 'Comece sua jornada! 🚀',
            message: 'Que tal registrar sua primeira despesa para ver como a IA pode te ajudar?',
            metadata: { step: 'activation_nudge' }
        }
    },
    {
        key: 'usage_limit',
        type: 'upgrade_offer',
        channel: 'banner',
        priority: 2,
        active: true, // Active for real users in rollout
        condition: async (user) => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const aiUsage = await prisma.aIUsage.findUnique({
                where: { userId_date: { userId: user.id, date: today } }
            });
            const limit = user.plan === 'pro' ? 50 : 3;
            return aiUsage && aiUsage.count >= limit;
        },
        payload: {
            title: 'Limite atingido! 💎',
            message: 'Você aproveitou ao máximo a IA hoje. Que tal o plano PRO para acesso ilimitado?',
            metadata: { context: 'usage_limit' }
        }
    },
    {
        key: 'low_retention',
        type: 'reengagement',
        channel: 'email',
        priority: 3,
        active: false, // STAYS IN SHADOW
        condition: async (user) => {
            const lastLogin = await prisma.event.findFirst({
                where: { userId: user.id, type: 'auth_success' },
                orderBy: { createdAt: 'desc' }
            });
            if (!lastLogin) return false;
            const hoursSinceLogin = (new Date() - new Date(lastLogin.createdAt)) / (1000 * 60 * 60);
            return hoursSinceLogin >= 24;
        },
        payload: {
            title: 'Volte ao controle! 🏠',
            message: 'Faz mais de 24h que não vemos você. Seu resumo financeiro está pronto.',
            metadata: { context: 'retention_24h' }
        }
    }
];

const runGrowthEngine = async () => {
    console.log(`🚀 [GROWTH ENGINE] Iniciando ativação controlada (${ROLLOUT_PERCENTAGE}% rollout)...`);
    
    const results = {
        totalProcessed: 0,
        rulesMatched: 0,
        actionsShadow: 0,
        actionsReal: 0,
        blocked: 0
    };

    let skip = 0;
    let hasMore = true;

    while (hasMore) {
        const users = await prisma.user.findMany({
            skip: skip,
            take: BATCH_SIZE,
            orderBy: { createdAt: 'desc' }
        });

        if (users.length === 0) {
            hasMore = false;
            break;
        }

        for (const user of users) {
            results.totalProcessed++;
            const inRollout = isInRollout(user.id);
            
            // Check Daily Limit
            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);
            const actionsToday = await prisma.growthAction.count({
                where: {
                    userId: user.id,
                    createdAt: { gte: startOfToday }
                }
            });

            if (actionsToday >= MAX_ACTIONS_PER_DAY) {
                results.blocked++;
                continue;
            }

            for (const rule of GROWTH_RULES) {
                // Check Rule-specific Cooldown (72h)
                const lastAction = await prisma.growthAction.findFirst({
                    where: {
                        userId: user.id,
                        ruleKey: rule.key,
                        createdAt: { gte: new Date(Date.now() - GLOBAL_COOLDOWN_HOURS * 60 * 60 * 1000) }
                    }
                });

                if (lastAction) continue;

                if (await rule.condition(user)) {
                    results.rulesMatched++;
                    
                    const shouldBeReal = inRollout && rule.active;
                    
                    await prisma.growthAction.create({
                        data: {
                            userId: user.id,
                            ruleKey: rule.key,
                            type: rule.type,
                            channel: rule.channel,
                            metadata: JSON.stringify(rule.payload),
                            isShadow: !shouldBeReal,
                            status: shouldBeReal ? 'pending' : 'shadow_logged'
                        }
                    });

                    if (shouldBeReal) {
                        results.actionsReal++;
                        await trackTelemetry(user.id, 'growth_active_triggered', { rule: rule.key });
                    } else {
                        results.actionsShadow++;
                        await trackTelemetry(user.id, 'growth_shadow_triggered', { rule: rule.key });
                    }
                    
                    break; // Priority system: one action per user per run
                }
            }
        }
        skip += BATCH_SIZE;
        if (skip > 5000) break;
    }

    console.log('📊 [GROWTH ENGINE] Resumo Fase 12.1:', results);
    return results;
};

module.exports = { runGrowthEngine };
