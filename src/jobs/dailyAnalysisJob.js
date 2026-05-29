const cron = require('node-cron');
const prisma = require('../../prisma/client');
const { calculateSummary, detectCategorySuggestions } = require('../engine/financialEngine');
const { getEmotionalAnalyticsSummary } = require('../analytics/behaviorMetrics');
const { generateDailyCoach } = require('../engine/coachEngine');
// [FASE 4] Observabilidade — no-op se Sentry não configurado
const { captureException } = require('../lib/sentry');

// prisma instance imported above

function isSameDay(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

async function runDailyAnalysis() {
  console.log('[DailyAnalysis] Iniciando análise diária...');

  try {
    const users = await prisma.user.findMany();

    for (const user of users) {
      try {
        const transactions = await prisma.transaction.findMany({ where: { userId: user.id } });
        const goals = await prisma.goal.findMany({ where: { userId: user.id } });

        const summary = calculateSummary(user, transactions, goals);
        const behaviorSummary = await getEmotionalAnalyticsSummary(user.id);

        await prisma.dailySnapshot.create({
          data: {
            userId: user.id,
            balance: summary.balance,
            monthlyExpenses: summary.monthlyExpenses,
            savingsRate: summary.savingsRate,
            riskLevel: summary.riskLevel,
            predictedExpenses: summary.predictedExpenses
          }
        });

        // 🧠 GENERATE BRAIN COACH MESSAGE
        const coach = generateDailyCoach({
            summary,
            user,
            behavior: {
                preventedExpenses: behaviorSummary.metrics.weeklyCancelled,
                confirmedRisks: behaviorSummary.metrics.weeklyConfirmed,
                smartEngagementRate: behaviorSummary.metrics.smartEngagementRate
            }
        });

        // 💾 Save Coach Insight
        await prisma.insight.create({
          data: {
            userId: user.id,
            message: coach.message,
            type: coach.type
          }
        });

        // 🔔 Notification for Coach
        await prisma.notification.create({
            data: {
                userId: user.id,
                title: '💡 Dica do Coach Financeiro',
                message: coach.message,
                type: 'ai_coach',
                priority: summary.riskLevel === 'ALTO' ? 'high' : 'medium'
            }
        });

        const lastSnapshot = await prisma.dailySnapshot.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          skip: 1
        });

        let notifications = [];

        if (summary.riskLevel === 'ALTO' && (!lastSnapshot || lastSnapshot.riskLevel !== 'ALTO')) {
          const preventionMessage = behaviorSummary.emotional.preventionMessage;
          notifications.push({
            userId: user.id,
            title: '⚠️ Atenção Necessária',
            message: `${preventionMessage.replace('🧠 ', '')} — use a simulação para ver alternativas seguras.`,
            type: 'warning',
            priority: 'high'
          });
        }

        if (summary.percentageMonthUsed > 80 && (!lastSnapshot || lastSnapshot.monthlyExpenses < summary.monthlyExpenses)) {
          const weeklyCancelled = behaviorSummary.metrics.weeklyCancelled;
          const message = weeklyCancelled > 0
            ? `Você evitou ${weeklyCancelled} gasto${weeklyCancelled > 1 ? 's' : ''} impulsivo${weeklyCancelled > 1 ? 's' : ''} essa semana — continue assim!`
            : `Você já gastou ${Math.round(summary.percentageMonthUsed)}% do orçamento. Que tal usar a simulação para planejar melhor?`;
          notifications.push({
            userId: user.id,
            title: '⛔ Orçamento em Alerta',
            message,
            type: 'warning',
            priority: 'high'
          });
        }

        if (summary.trend > 0.15 && summary.trendDirection === 'up') {
          const engagementMessage = behaviorSummary.emotional.engagementMessage;
          notifications.push({
            userId: user.id,
            title: '📈 Gastos em Alta',
            message: `${engagementMessage.replace('🔍 ', '')} — que tal usar a simulação para entender o impacto?`,
            type: 'warning',
            priority: 'high'
          });
        }

        if (summary.trend < -0.15 && summary.trendDirection === 'down') {
          const consistencyMessage = behaviorSummary.emotional.consistencyMessage;
          notifications.push({
            userId: user.id,
            title: '📉 Progresso na Economia',
            message: `${consistencyMessage.replace('🔥 ', '')} — você está no caminho certo!`,
            type: 'achievement',
            priority: 'low'
          });
        }

        if (summary.goalProjections.some((g) => g.status === 'behind')) {
          const behindGoal = summary.goalProjections.find((g) => g.status === 'behind');
          if (behindGoal) {
            const smartEngagement = behaviorSummary.metrics.smartEngagementRate;
            const message = smartEngagement > 0.3
              ? `"${behindGoal.title}" precisa de atenção. Você já usa simulações bem — que tal uma agora?`
              : `"${behindGoal.title}" está atrasada. Use a simulação para criar um plano de recuperação.`;
            notifications.push({
              userId: user.id,
              title: '🎯 Meta Precisa de Atenção',
              message,
              type: 'opportunity',
              priority: 'medium'
            });
          }
        }

        const categoryAnalysis = detectCategorySuggestions(transactions);
        for (const suggestion of categoryAnalysis.suggestions) {
          if (suggestion.severity === 'high') {
            const existingAlert = await prisma.patternAlert.findFirst({
              where: { userId: user.id, category: suggestion.category }
            });

            if (!existingAlert) {
              await prisma.patternAlert.create({
                data: {
                  userId: user.id,
                  category: suggestion.category,
                  percentage: suggestion.percentage,
                  message: suggestion.recommendation,
                  severity: suggestion.severity
                }
              });

              notifications.push({
                userId: user.id,
                title: `⚠️ ${suggestion.category} Acima do Ideal`,
                message: suggestion.recommendation,
                type: 'warning',
                priority: 'high'
              });
            }
          }
        }

        const hasCheckedInToday = user.lastCheckIn && isSameDay(new Date(), user.lastCheckIn);
        if (!hasCheckedInToday) {
          const todayReminder = await prisma.notification.findFirst({
            where: {
              userId: user.id,
              title: '📌 Momento de Reflexão',
              createdAt: {
                gte: startOfToday()
              }
            }
          });

          if (!todayReminder) {
            const consistencyMessage = behaviorSummary.emotional.consistencyMessage;
            const message = consistencyMessage.includes('comece hoje')
              ? 'Que tal começar hoje criando o hábito do check-in diário?'
              : `${consistencyMessage.replace('🔥 ', '')} — mantenha o ritmo com seu check-in diário.`;
            notifications.push({
              userId: user.id,
              title: '📌 Momento de Reflexão',
              message,
              type: 'opportunity',
              priority: 'medium'
            });
          }
        }

        if (notifications.length > 0) {
          await prisma.notification.createMany({ data: notifications });
          console.log(`[DailyAnalysis] ${notifications.length} notificações criadas para ${user.id}`);
        }
      } catch (error) {
        console.error(`[DailyAnalysis] Erro ao processar usuário ${user.id}:`, error.message);
        // [FASE 4] Captura por-user para diagnosticar bugs silenciosos como o do coachEngine
        captureException(error, {
          tags: { cron: 'daily_analysis', stage: 'per_user' },
          userId: user.id,
        });
      }
    }

    console.log('[DailyAnalysis] Análise diária concluída!');
  } catch (error) {
    console.error('[DailyAnalysis] Erro geral:', error);
    captureException(error, { tags: { cron: 'daily_analysis', stage: 'top_level' } });
  }
}

function startDailyAnalysisJob() {
  console.log('[CronJobs] Iniciando agendador de análises...');
  cron.schedule('0 6 * * *', async () => {
    await runDailyAnalysis();
  });
  console.log('[CronJobs] Job diário agendado para as 06:00');
}

module.exports = {
  startDailyAnalysisJob,
  runDailyAnalysis
};
