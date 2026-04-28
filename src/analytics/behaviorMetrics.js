const prisma = require('../prisma/client');
// prisma instance imported above

// Track behavior events
async function trackEvent(userId, type, category = null, data = null) {
  try {
    await prisma.behaviorEvent.create({
      data: {
        userId,
        type,
        category,
        data
      }
    });
  } catch (error) {
    console.error('Error tracking behavior event:', error);
  }
}

// Calculate behavioral metrics
async function calculateMetrics(userId) {
  try {
    const events = await prisma.behaviorEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    // Transaction warning metrics
    const warnings = events.filter(e => e.type === 'transaction_warning_shown').length;
    const cancelled = events.filter(e => e.type === 'transaction_cancelled_after_warning').length;
    const confirmed = events.filter(e => e.type === 'transaction_confirmed_anyway').length;

    const cancelRate = warnings > 0 ? cancelled / warnings : 0;

    // Smart engagement: simulation usage after warning
    const recentWarnings = events
      .filter(e => e.type === 'transaction_warning_shown')
      .slice(0, 10); // Last 10 warnings

    let simulationAfterWarning = 0;
    for (const warning of recentWarnings) {
      const warningTime = new Date(warning.createdAt);
      const subsequentSimulations = events.filter(e =>
        e.type === 'simulation_used' &&
        new Date(e.createdAt) > warningTime &&
        new Date(e.createdAt) < new Date(warningTime.getTime() + 24 * 60 * 60 * 1000) // Within 24 hours
      );
      if (subsequentSimulations.length > 0) {
        simulationAfterWarning++;
      }
    }

    const smartEngagementRate = recentWarnings.length > 0 ? simulationAfterWarning / recentWarnings.length : 0;

    // Consistency: average streak from checkins
    const checkins = events.filter(e => e.type === 'daily_checkin');
    const streaks = [];
    let currentStreak = 0;
    let lastDate = null;

    for (const checkin of checkins.reverse()) { // Process in chronological order
      const checkinDate = new Date(checkin.createdAt).toDateString();
      if (lastDate === null) {
        currentStreak = 1;
      } else {
        const diff = Math.floor((new Date(checkinDate) - new Date(lastDate)) / (1000 * 60 * 60 * 24));
        if (diff === 1) {
          currentStreak++;
        } else {
          if (currentStreak > 0) streaks.push(currentStreak);
          currentStreak = 1;
        }
      }
      lastDate = checkinDate;
    }
    if (currentStreak > 0) streaks.push(currentStreak);

    const averageStreak = streaks.length > 0 ? streaks.reduce((a, b) => a + b, 0) / streaks.length : 0;

    // Weekly impulsive spends avoided
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const recentCancelled = events.filter(e =>
      e.type === 'transaction_cancelled_after_warning' &&
      new Date(e.createdAt) > weekAgo
    ).length;

    return {
      cancelRate: Number(cancelRate.toFixed(2)),
      smartEngagementRate: Number(smartEngagementRate.toFixed(2)),
      averageStreak: Number(averageStreak.toFixed(1)),
      weeklyCancelled: recentCancelled,
      totalEvents: events.length,
      lastWeekEvents: events.filter(e => new Date(e.createdAt) > weekAgo).length
    };
  } catch (error) {
    console.error('Error calculating metrics:', error);
    return {
      cancelRate: 0,
      smartEngagementRate: 0,
      averageStreak: 0,
      weeklyCancelled: 0,
      totalEvents: 0,
      lastWeekEvents: 0
    };
  }
}

// Get analytics summary
async function getAnalyticsSummary(userId) {
  const metrics = await calculateMetrics(userId);

  // Calculate improvement trends (compare with previous period)
  const user = await prisma.user.findUnique({ where: { id: userId } });

  return {
    metrics,
    user: {
      streakDays: user.streakDays,
      totalTransactions: await prisma.transaction.count({ where: { userId } }),
      totalGoals: await prisma.goal.count({ where: { userId } })
    }
  };
}

// Translate metrics into emotional, motivational messages
function translatePreventionRate(cancelRate) {
  const rate = Math.round(cancelRate * 100);
  if (rate >= 50) return `🧠 Você evitou quase metade dos gastos impulsivos`;
  if (rate >= 30) return `🧠 Você evitou ${rate}% dos gastos de risco — ótimo sinal`;
  if (rate >= 10) return `🧠 Você está começando a evitar gastos impulsivos`;
  return `🧠 Ainda há espaço para melhorar o controle de gastos`;
}

function translateSmartEngagement(smartEngagementRate) {
  const rate = Math.round(smartEngagementRate * 100);
  if (rate >= 50) return `🔍 Você reflete antes de gastar — sinal de maturidade financeira`;
  if (rate >= 25) return `🔍 Você usa simulações quando alertado — comportamento inteligente`;
  if (rate >= 10) return `🔍 Às vezes você reflete antes de decidir — continue assim`;
  return `🔍 Use as simulações para tomar decisões mais conscientes`;
}

function translateConsistency(averageStreak) {
  const streak = Math.round(averageStreak);
  if (streak >= 7) return `🔥 ${streak} dias de consistência — isso cria resultado real`;
  if (streak >= 5) return `🔥 ${streak} dias seguidos no controle — você está no caminho`;
  if (streak >= 3) return `🔥 ${streak} dias de disciplina — mantenha o ritmo`;
  if (streak >= 1) return `🔥 Você começou a criar hábitos — continue assim`;
  return `🔥 Comece hoje criando uma rotina de check-in diário`;
}

function translateWeeklyCancelled(weeklyCancelled) {
  if (weeklyCancelled >= 5) return `Você evitou ${weeklyCancelled} gastos impulsivos`;
  if (weeklyCancelled >= 3) return `Você evitou ${weeklyCancelled} gastos impulsivos`;
  if (weeklyCancelled >= 1) return `Você evitou ${weeklyCancelled} gasto impulsivo`;
  return `Você ainda não evitou gastos impulsivos essa semana`;
}

function calculateImprovement(metrics, previousMetrics) {
  if (!previousMetrics) return null;

  const currentRate = metrics.cancelRate;
  const previousRate = previousMetrics.cancelRate;
  const improvement = ((currentRate - previousRate) / previousRate) * 100;

  if (improvement > 20) return `Seu controle melhorou ${Math.round(improvement)}%`;
  if (improvement > 10) return `Seu controle melhorou ${Math.round(improvement)}%`;
  if (improvement > 0) return `Seu controle melhorou um pouco`;
  if (improvement < -10) return `Seu controle teve uma queda`;
  return `Seu controle se manteve estável`;
}

// Generate weekly smart summary
function generateWeeklySummary(metrics, improvement = null) {
  const prevention = translateWeeklyCancelled(metrics.weeklyCancelled);
  const consistency = translateConsistency(metrics.averageStreak);
  const engagement = translateSmartEngagement(metrics.smartEngagementRate);
  const improvementText = improvement || 'Continue monitorando seu progresso';

  return {
    title: '📊 Sua semana financeira:',
    highlights: [
      prevention,
      consistency,
      engagement
    ],
    conclusion: `🎯 ${improvementText} — você está no caminho certo`,
    fullMessage: `📊 Sua semana financeira:\n\n${prevention}\n${consistency}\n${engagement}\n\n🎯 ${improvementText} — você está no caminho certo`
  };
}

// Generate achievement badges
function generateBadges(metrics, user) {
  const badges = [];

  if (metrics.cancelRate >= 0.5) {
    badges.push({
      icon: '🧠',
      title: 'Mestre da Prevenção',
      description: 'Evitou mais da metade dos gastos de risco'
    });
  }

  if (metrics.averageStreak >= 7) {
    badges.push({
      icon: '🔥',
      title: 'Consistente',
      description: `${Math.round(metrics.averageStreak)} dias de disciplina`
    });
  }

  if (metrics.smartEngagementRate >= 0.5) {
    badges.push({
      icon: '🔍',
      title: 'Decisor Inteligente',
      description: 'Reflete antes de gastar'
    });
  }

  if (user.streakDays >= 7) {
    badges.push({
      icon: '🎯',
      title: 'Hábitos Fortes',
      description: `${user.streakDays} dias seguidos`
    });
  }

  return badges;
}

// Get emotional analytics summary with translations
async function getEmotionalAnalyticsSummary(userId) {
  const summary = await getAnalyticsSummary(userId);
  const metrics = summary.metrics;

  // Get previous week's metrics for comparison (simplified - in real app you'd store historical data)
  const previousMetrics = null; // TODO: implement historical comparison

  const improvement = calculateImprovement(metrics, previousMetrics);
  const weeklySummary = generateWeeklySummary(metrics, improvement);
  const badges = generateBadges(metrics, summary.user);

  return {
    ...summary,
    emotional: {
      preventionMessage: translatePreventionRate(metrics.cancelRate),
      engagementMessage: translateSmartEngagement(metrics.smartEngagementRate),
      consistencyMessage: translateConsistency(metrics.averageStreak),
      weeklySummary,
      badges
    }
  };
}

// Get personal timeline of financial evolution
async function getPersonalTimeline(userId, days = 30) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get daily snapshots for timeline
    const snapshots = await prisma.dailySnapshot.findMany({
      where: {
        userId,
        createdAt: { gte: startDate }
      },
      orderBy: { createdAt: 'asc' }
    });

    // Get behavior events for key moments
    const events = await prisma.behaviorEvent.findMany({
      where: {
        userId,
        createdAt: { gte: startDate }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Calculate key milestones
    const timeline = [];
    let previousRiskLevel = null;
    let previousSavingsRate = null;

    for (const snapshot of snapshots) {
      const date = snapshot.createdAt.toISOString().split('T')[0];

      // Risk level changes
      if (previousRiskLevel && previousRiskLevel !== snapshot.riskLevel) {
        const improvement = getRiskLevelChange(previousRiskLevel, snapshot.riskLevel);
        timeline.push({
          date,
          type: 'risk_change',
          title: `Mudança no nível de risco`,
          description: `De ${previousRiskLevel} para ${snapshot.riskLevel}`,
          impact: improvement,
          icon: improvement === 'improvement' ? '📈' : '📉'
        });
      }

      // Savings rate improvements
      if (previousSavingsRate !== null) {
        const change = snapshot.savingsRate - previousSavingsRate;
        if (Math.abs(change) > 0.05) { // 5% change
          timeline.push({
            date,
            type: 'savings_change',
            title: `Taxa de economia ${change > 0 ? 'melhorou' : 'piorou'}`,
            description: `${Math.abs(change * 100).toFixed(1)}% ${change > 0 ? 'a mais' : 'a menos'}`,
            impact: change > 0 ? 'improvement' : 'decline',
            icon: change > 0 ? '💰' : '⚠️'
          });
        }
      }

      previousRiskLevel = snapshot.riskLevel;
      previousSavingsRate = snapshot.savingsRate;
    }

    // Add behavior milestones
    const weeklyCancelled = events.filter(e => e.type === 'transaction_cancelled_after_warning').length;
    if (weeklyCancelled > 0) {
      timeline.push({
        date: new Date().toISOString().split('T')[0],
        type: 'behavior_milestone',
        title: 'Controle de impulsos',
        description: `Você evitou ${weeklyCancelled} gasto${weeklyCancelled > 1 ? 's' : ''} impulsivo${weeklyCancelled > 1 ? 's' : ''} recentemente`,
        impact: 'improvement',
        icon: '🧠'
      });
    }

    // Add streak milestones
    if (user.streakDays >= 7) {
      timeline.push({
        date: new Date().toISOString().split('T')[0],
        type: 'streak_milestone',
        title: 'Consistência excepcional',
        description: `${user.streakDays} dias seguidos de controle financeiro`,
        impact: 'improvement',
        icon: '🔥'
      });
    }

    return timeline.sort((a, b) => new Date(b.date) - new Date(a.date));
  } catch (error) {
    console.error('Error generating personal timeline:', error);
    return [];
  }
}

function getRiskLevelChange(from, to) {
  const levels = { 'BAIXO': 1, 'MÉDIO': 2, 'ALTO': 3 };
  return levels[to] < levels[from] ? 'improvement' : 'decline';
}

module.exports = {
  trackEvent,
  calculateMetrics,
  getAnalyticsSummary,
  getEmotionalAnalyticsSummary,
  generateWeeklySummary,
  generateBadges,
  getPersonalTimeline
};