const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { calculateSummary } = require('./financialEngine');

const prisma = new PrismaClient();

function isSameDay(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(0, 0, 0);
  d.setSeconds(0, 0);
  d.setMilliseconds(0);
  return d;
}

function getRules(now) {
  const day = now.getDay();
  const hour = now.getHours();
  const dayOfMonth = now.getDate();

  const rules = [];

  if (day === 5 && hour >= 18) {
    rules.push({
      key: 'friday_evening',
      title: 'Cuidado com gastos impulsivos hoje 👀',
      message: 'Sexta-feira à noite pode favorecer compras por impulso. Reveja seu carrinho antes de concluir.',
      type: 'warning',
      condition: () => true
    });
  }

  if (dayOfMonth <= 3) {
    rules.push({
      key: 'start_of_month',
      title: 'Hora de planejar o mês',
      message: 'Defina seu plano financeiro para o mês e evite surpresas nos próximos 30 dias.',
      type: 'opportunity',
      condition: () => true
    });
  }

  if (dayOfMonth === 15) {
    rules.push({
      key: 'mid_month',
      title: 'Você já gastou mais da metade',
      message: 'Está na metade do mês e já usou mais de 50% do orçamento. Cuidado com o ritmo.',
      type: 'warning',
      condition: (summary) => summary.percentageMonthUsed > 50
    });
  }

  if (dayOfMonth >= 25) {
    rules.push({
      key: 'end_of_month',
      title: 'Últimos dias do mês',
      message: 'Faltam poucos dias para fechar o mês. Segure os gastos e priorize o essencial.',
      type: 'opportunity',
      condition: () => true
    });
  }

  if (day === 0 && hour >= 18) {
    rules.push({
      key: 'weekly_summary',
      title: 'Seu progresso da semana está pronto',
      message: 'Seu progresso da semana está pronto — vale a pena ver isso.',
      type: 'weekly_summary',
      condition: () => true
    });
  }

  return rules;
}

async function runNotificationScheduler() {
  console.log('[NotificationScheduler] Verificando disparos de notificação...');

  try {
    const now = new Date();
    const rules = getRules(now);
    if (!rules.length) {
      return;
    }

    const users = await prisma.user.findMany();
    const todayStart = startOfDay(now);

    for (const user of users) {
      // Verificar se usuário está em modo silêncio
      const recentNotifications = await prisma.notification.findMany({
        where: {
          userId: user.id,
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Últimos 7 dias
        },
        orderBy: { createdAt: 'desc' },
        take: 10
      });

      const unreadCount = recentNotifications.filter(n => !n.read).length;
      const isSilentMode = unreadCount >= 3; // Se tem 3+ notificações não lidas, entra em modo silêncio

      if (isSilentMode) {
        console.log(`[NotificationScheduler] Usuário ${user.email} em modo silêncio (${unreadCount} não lidas)`);
        continue; // Pula notificações para este usuário
      }

      const transactions = await prisma.transaction.findMany({ where: { userId: user.id } });
      const goals = await prisma.goal.findMany({ where: { userId: user.id } });
      const summary = calculateSummary(user, transactions, goals);

      const notifications = [];
      for (const rule of rules) {
        if (!rule.condition(summary)) {
          continue;
        }

        const alreadySent = await prisma.notification.findFirst({
          where: {
            userId: user.id,
            title: rule.title,
            createdAt: { gte: todayStart }
          }
        });

        if (!alreadySent) {
          notifications.push({
            userId: user.id,
            title: rule.title,
            message: rule.message,
            type: rule.type,
            priority: rule.type === 'warning' ? 'high' : rule.type === 'opportunity' ? 'medium' : 'low'
          });
        }
      }

      if (notifications.length > 0) {
        await prisma.notification.createMany({ data: notifications });
        console.log(`[NotificationScheduler] ${notifications.length} notificações criadas para ${user.email}`);
      }
    }
  } catch (error) {
    console.error('[NotificationScheduler] Erro ao gerar notificações:', error);
  }
}

function startNotificationScheduler() {
  console.log('[NotificationScheduler] Iniciando agendador de notificações...');
  cron.schedule('0 * * * *', async () => {
    await runNotificationScheduler();
  });
  runNotificationScheduler();
  console.log('[NotificationScheduler] Executando verificação a cada hora');
}

module.exports = {
  startNotificationScheduler,
  runNotificationScheduler
};
