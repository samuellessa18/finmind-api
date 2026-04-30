const express = require('express');
const prisma = require('../../prisma/client');
const { authenticateToken } = require('../middleware/auth');
const { getProductInsights } = require('../services/productInsightsService');
const { runGrowthEngine } = require('../services/growthEngineService');

const router = express.Router();

// Middleware de proteção adicional para Admin
const requireAdmin = (req, res, next) => {
    const adminToken = process.env.ADMIN_TOKEN;
    const providedToken = req.headers['x-admin-token'];

    if (!adminToken || providedToken !== adminToken) {
        return res.status(403).json({ success: false, message: 'Acesso negado: Token admin inválido.' });
    }
    next();
};

const calculateMedian = (values) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
};

/**
 * GET /api/v1/admin/metrics
 * Retorna métricas globais de saúde do negócio segmentadas por provider
 */
router.get('/metrics', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const providers = ['local', 'google', 'hybrid'];
        
        // 1. Métricas Gerais
        const [totalUsers, totalInsights, proUsers] = await Promise.all([
            prisma.user.count(),
            prisma.insight.count(),
            prisma.user.count({ where: { plan: 'pro' } })
        ]);

        const conversionRate = totalUsers > 0 ? (proUsers / totalUsers) * 100 : 0;

        // 2. Métricas Segmentadas por Provider
        const segmentedData = {};

        for (const provider of providers) {
            const users = await prisma.user.findMany({
                where: { provider },
                select: { id: true, createdAt: true }
            });
            const userIds = users.map(u => u.id);
            const userCount = userIds.length;

            if (userCount === 0) {
                segmentedData[provider] = { userCount: 0, rates: { activation: '0%', engagement: '0%', paymentIntent: '0%' } };
                continue;
            }

            const [
                activationEvents,
                engagementEvents,
                limitReachedEvents,
                upgradeClickedEvents,
                authStarted,
                authSuccess
            ] = await Promise.all([
                prisma.event.count({ where: { type: 'first_transaction_created', userId: { in: userIds } } }),
                prisma.event.count({ where: { type: 'first_insight_generated', userId: { in: userIds } } }),
                prisma.event.count({ where: { type: 'usage_limit_reached', userId: { in: userIds } } }),
                prisma.event.count({ where: { type: 'upgrade_clicked', userId: { in: userIds } } }),
                prisma.event.count({ where: { type: 'auth_started', metadata: { contains: provider } } }),
                prisma.event.count({ where: { type: 'auth_success', userId: { in: userIds } } })
            ]);

            // Time to Activation (Cálculo robusto)
            const activationTimes = await prisma.event.findMany({
                where: { type: 'first_transaction_created', userId: { in: userIds } },
                select: { userId: true, createdAt: true }
            });

            const diffs = activationTimes.map(event => {
                const user = users.find(u => u.id === event.userId);
                return (new Date(event.createdAt) - new Date(user.createdAt)) / (1000 * 60); // em minutos
            });

            const avgTime = diffs.length > 0 ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
            const medianTime = calculateMedian(diffs);

            // Retenção D1/D7 (Simplificada para MVP)
            const oneDayAgo = new Date(); oneDayAgo.setDate(oneDayAgo.getDate() - 1);
            const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const retentionD1 = await prisma.event.count({
                where: { 
                    userId: { in: userIds },
                    type: 'auth_success',
                    createdAt: { gte: oneDayAgo }
                }
            });

            segmentedData[provider] = {
                userCount,
                rates: {
                    activation: Number(((activationEvents / userCount) * 100).toFixed(2)) + '%',
                    engagement: Number(((engagementEvents / userCount) * 100).toFixed(2)) + '%',
                    paymentIntent: limitReachedEvents > 0 ? Number(((upgradeClickedEvents / limitReachedEvents) * 100).toFixed(2)) + '%' : '0%',
                    authConversion: authStarted > 0 ? Number(((authSuccess / authStarted) * 100).toFixed(2)) + '%' : '0%',
                    retentionD1: Number(((retentionD1 / userCount) * 100).toFixed(2)) + '%'
                },
                timing: {
                    avgActivationMinutes: Math.round(avgTime),
                    medianActivationMinutes: Math.round(medianTime)
                }
            };
        }

        res.json({
            success: true,
            data: {
                summary: {
                    totalUsers,
                    proUsers,
                    totalInsights,
                    conversionRate: Number(conversionRate.toFixed(2)) + '%'
                },
                segmented: segmentedData
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/v1/admin/product-insights
 * Gera recomendações automáticas baseadas em heurísticas de negócio
 */
router.get('/product-insights', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const insights = await getProductInsights();
        res.json({
            success: true,
            data: insights
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/v1/admin/growth/run
 * Executa o motor de growth para processar automações de usuários
 */
router.post('/growth/run', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const results = await runGrowthEngine();
        res.json({
            success: true,
            data: results
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
