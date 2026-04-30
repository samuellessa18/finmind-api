const prisma = require('../../prisma/client');

const calculateMedian = (values) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
};

const getProductInsights = async () => {
    const providers = ['local', 'google', 'hybrid'];
    const insights = [];
    const metrics = {};

    for (const provider of providers) {
        const users = await prisma.user.findMany({
            where: { provider },
            select: { id: true, createdAt: true }
        });
        const userIds = users.map(u => u.id);
        const userCount = userIds.length;

        if (userCount === 0) continue;

        const [
            activationEvents,
            authStarted,
            authSuccess,
            retentionD1
        ] = await Promise.all([
            prisma.event.count({ where: { type: 'first_transaction_created', userId: { in: userIds } } }),
            prisma.event.count({ where: { type: 'auth_started', metadata: { contains: provider } } }),
            prisma.event.count({ where: { type: 'auth_success', userId: { in: userIds } } }),
            prisma.event.count({
                where: { 
                    userId: { in: userIds },
                    type: 'auth_success',
                    createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
                }
            })
        ]);

        const activationRate = (activationEvents / userCount) * 100;
        const authConversion = authStarted > 0 ? (authSuccess / authStarted) * 100 : 0;
        const retentionRate = (retentionD1 / userCount) * 100;

        metrics[provider] = { activationRate, authConversion, retentionRate };

        // --- Heurísticas de Insights ---

        // 1. Fricção de Autenticação
        if (authConversion < 70) {
            insights.push({
                type: 'auth_friction',
                severity: 'high',
                provider,
                message: `O fluxo de login via ${provider} apresenta alta fricção (${authConversion.toFixed(1)}%).`,
                recommendation: provider === 'google' 
                    ? 'Verifique se o redirecionamento OAuth está rápido ou se há erros no callback.' 
                    : 'Considere simplificar o formulário ou habilitar login sem senha.'
            });
        } else if (authConversion < 85) {
            insights.push({
                type: 'auth_friction',
                severity: 'medium',
                provider,
                message: `Conversão de login via ${provider} pode ser otimizada.`,
                recommendation: 'Verifique o tempo de carregamento da página de login.'
            });
        }

        // 2. Abandono no Onboarding
        if (activationRate < 40) {
            insights.push({
                type: 'onboarding_dropoff',
                severity: 'high',
                provider,
                message: `Usuários ${provider} estão com baixa taxa de ativação (${activationRate.toFixed(1)}%).`,
                recommendation: 'Implemente um guia passo-a-passo (product tour) logo após o primeiro acesso.'
            });
        }

        // 3. Valor Percebido (Retenção)
        if (retentionRate < 25) {
            insights.push({
                type: 'retention_risk',
                severity: 'high',
                provider,
                message: `Baixa retenção D1 para usuários ${provider} (${retentionRate.toFixed(1)}%).`,
                recommendation: 'Envie uma notificação push ou e-mail de "Boas-vindas" com o primeiro insight de IA.'
            });
        }
    }

    // --- Comparações Estratégicas ---
    if (metrics.google && metrics.local) {
        const diff = metrics.google.activationRate - metrics.local.activationRate;
        if (diff > 15) {
            insights.push({
                type: 'strategy_win',
                severity: 'low',
                message: `Google OAuth está gerando usuários 15%+ mais ativos que o login local.`,
                recommendation: 'Dê maior destaque ao botão "Continuar com Google" na UI.'
            });
        } else if (diff < -10) {
            insights.push({
                type: 'strategy_issue',
                severity: 'medium',
                message: `Usuários Google estão menos engajados que usuários locais.`,
                recommendation: 'Verifique se o onboarding está sendo exibido corretamente para quem vem via OAuth.'
            });
        }
    }

    return {
        timestamp: new Date(),
        insights: insights.sort((a, b) => {
            const order = { high: 0, medium: 1, low: 2 };
            return order[a.severity] - order[b.severity];
        }),
        summary: {
            criticalIssues: insights.filter(i => i.severity === 'high').length,
            totalInsights: insights.length
        }
    };
};

module.exports = { getProductInsights };
