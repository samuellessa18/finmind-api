const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const prisma = require('../prisma/client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const OpenAI = require('openai');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { calculateSummary } = require('./engine/financialEngine');
const { startDailyAnalysisJob, runDailyAnalysis } = require('./jobs/dailyAnalysisJob');
const { startNotificationScheduler } = require('./engine/notificationScheduler');
const { trackEvent, getAnalyticsSummary, getEmotionalAnalyticsSummary, getPersonalTimeline } = require('./analytics/behaviorMetrics');
const { addXP } = require('./services/gamificationService');
const financeRoutes = require('./routes/financeRoutes');
dotenv.config();

const app = express();
// prisma instance is now imported from prisma/client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: { error: 'Muitas tentativas, tente novamente mais tarde.' }
});

const insightsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Muitas solicitações de insights, aguarde um minuto.' }
});

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:19006',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true
}));
app.use(express.json());

// 🩺 Health Check & Diagnostics (Production)
app.get('/api/health', async (req, res) => {
  try {
    // Definitive test: a real query to the database
    await prisma.$queryRaw`SELECT 1`;

    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      env: process.env.NODE_ENV || 'production',
      version: '1.0.0',
      database: 'connected'
    });
  } catch (error) {
    console.error('[Health Check Error]:', error.message);
    res.status(500).json({ 
      status: 'error', 
      database: 'disconnected',
      message: 'Falha na conexão com o banco de dados'
    });
  }
});

// Main Modular Routes
app.use('/api/finance', financeRoutes);
const authenticateToken = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Acesso negado' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
};

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  monthlyIncome: z.number().nonnegative().optional().default(0)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

const transactionSchema = z.object({
  type: z.enum(['income', 'expense']),
  category: z.string().min(1),
  amount: z.number().positive(),
  date: z.string().optional(),
  description: z.string().optional(),
  confirmWarning: z.boolean().optional()
});

const goalSchema = z.object({
  title: z.string().min(1),
  targetAmount: z.number().positive(),
  deadline: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Data inválida' })
});

const profileSchema = z.object({
  spendingPattern: z.enum(['impulsivo', 'planejador', 'controlado']),
  riskTolerance: z.enum(['alto', 'médio', 'baixo'])
});

const simulationSchema = z.object({
  incomeAdjustment: z.number().optional(),
  expenseAdjustment: z.number().optional(),
  extraMonthlySavings: z.number().optional(),
  goalId: z.string().optional()
});

const onboardingSchema = z.object({
  monthlyIncome: z.number().positive(),
  goal: z.object({
    title: z.string().min(1),
    targetAmount: z.number().positive(),
    deadline: z.string()
  })
});

const parseRequest = (schema, data) => {
  try {
    return { success: true, data: schema.parse(data) };
  } catch (error) {
    return { success: false, errors: error.errors.map((err) => err.message) };
  }
};

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayDifference(dateA, dateB) {
  const diff = startOfDay(dateA) - startOfDay(dateB);
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const payload = {
    ...req.body,
    monthlyIncome: Number(req.body.monthlyIncome || 0)
  };
  const result = parseRequest(registerSchema, payload);
  if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

  try {
    const hashedPassword = await bcrypt.hash(result.data.password, 10);
    const environment = await prisma.environment.create({
      data: { name: `Ambiente de ${result.data.name}` }
    });

    const user = await prisma.user.create({
      data: {
        name: result.data.name,
        email: result.data.email,
        password: hashedPassword,
        monthlyIncome: result.data.monthlyIncome,
        environmentId: environment.id
      }
    });
    const token = jwt.sign({ id: user.id, environmentId: user.environmentId }, process.env.JWT_SECRET);
    res.json({ user, token });
  } catch (error) {
    res.status(400).json({ error: 'Erro ao registrar usuário' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const payload = { ...req.body };
  const result = parseRequest(loginSchema, payload);
  if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

  try {
    const user = await prisma.user.findUnique({ where: { email: result.data.email } });
    if (!user || !(await bcrypt.compare(result.data.password, user.password))) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const token = jwt.sign({ id: user.id, environmentId: user.environmentId }, process.env.JWT_SECRET);
    res.json({ user, token });
  } catch (error) {
    res.status(400).json({ error: 'Erro ao fazer login' });
  }
});

app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const transactions = await prisma.transaction.findMany({ where: { userId: req.user.id } });
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar transações' });
  }
});

app.post('/api/transactions', authenticateToken, async (req, res) => {
  const payload = {
    ...req.body,
    amount: Number(req.body.amount),
    date: req.body.date || new Date().toISOString(),
    confirmWarning: req.body.confirmWarning === true
  };
  const result = parseRequest(transactionSchema, payload);
  if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const monthlyExpenses = await prisma.transaction.findMany({
      where: {
        userId: req.user.id,
        type: 'expense',
        date: { gte: monthStart }
      }
    });

    const categoryExpenses = monthlyExpenses.filter((tx) => tx.category === result.data.category)
      .reduce((sum, tx) => sum + tx.amount, 0);
    const totalMonthExpenses = monthlyExpenses.reduce((sum, tx) => sum + tx.amount, 0);
    const projectedCategoryTotal = categoryExpenses + result.data.amount;
    const categoryShareOfIncome = user.monthlyIncome > 0 ? projectedCategoryTotal / user.monthlyIncome : 0;
    const categoryShareOfExpenses = totalMonthExpenses > 0 ? projectedCategoryTotal / (totalMonthExpenses + result.data.amount) : 0;
    const warningThreshold = result.data.type === 'expense' && (categoryShareOfIncome > 0.18 || categoryShareOfExpenses > 0.55);

    const alternatives = [
      `Reduzir ${result.data.category} em 10% nas próximas semanas`,
      'Adiar compras não essenciais para o próximo mês',
      `Aumentar a economia mensal em R$ ${Math.max(50, Math.round(result.data.amount * 0.5))}`
    ];

    if (warningThreshold && !result.data.confirmWarning) {
      // Track warning shown
      await trackEvent(req.user.id, 'transaction_warning_shown', result.data.category, {
        amount: result.data.amount,
        projectedCategoryTotal,
        categoryShareOfIncome
      });

      return res.status(409).json({
        warning: true,
        message: `⚠️ Atenção: você já está gastando cerca de ${Math.round(categoryShareOfIncome * 100)}% da sua renda neste(a) ${result.data.category} este mês.`,
        category: result.data.category,
        projectedCategoryTotal: Number(projectedCategoryTotal.toFixed(2)),
        currentCategoryTotal: Number(categoryExpenses.toFixed(2)),
        alternatives
      });
    }

    const transaction = await prisma.transaction.create({
      data: {
        userId: req.user.id,
        type: result.data.type,
        category: result.data.category,
        amount: result.data.amount,
        date: new Date(result.data.date),
        description: result.data.description || ''
      }
    });

    // Track transaction creation
    if (result.data.confirmWarning) {
      await trackEvent(req.user.id, 'transaction_confirmed_anyway', result.data.category, {
        amount: result.data.amount
      });
    }

    const impactMessage = result.data.type === 'expense'
      ? categoryShareOfIncome > 0.18
        ? `+R$ ${result.data.amount.toFixed(2)} registrado — 🔴 Meta impactada, ritmo acelerando.`
        : `+R$ ${result.data.amount.toFixed(2)} registrado — 🟢 Ainda dentro do controle.`
      : `+R$ ${result.data.amount.toFixed(2)} registrado como receita.`;

    // Gamification Hook
    const xpReward = result.data.type === 'income' ? 5 : 2;
    const gamification = await addXP(req.user.id, xpReward, result.data.type === 'income' ? 'Nova receita registrada' : 'Gasto registrado com sucesso');

    res.json({ transaction, impactMessage, gamification });
  } catch (error) {
    res.status(400).json({ error: 'Erro ao criar transação' });
  }
});

app.delete('/api/transactions/:id', authenticateToken, async (req, res) => {
  try {
    await prisma.transaction.delete({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: 'Erro ao excluir transação' });
  }
});

app.get('/api/goals', authenticateToken, async (req, res) => {
  try {
    const goals = await prisma.goal.findMany({ where: { userId: req.user.id } });
    res.json(goals);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar metas' });
  }
});

app.post('/api/goals', authenticateToken, async (req, res) => {
  const payload = { ...req.body };
  const result = parseRequest(goalSchema, payload);
  if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

  try {
    const goal = await prisma.goal.create({
      data: {
        userId: req.user.id,
        title: result.data.title,
        type: req.body.type || 'travel',
        targetAmount: result.data.targetAmount,
        currentAmount: req.body.currentAmount || 0,
        deadline: new Date(result.data.deadline)
      }
    });

    // Gamification Hook
    await addXP(req.user.id, 20, `Novo objetivo planejado: ${goal.title}`);

    res.json(goal);
  } catch (error) {
    res.status(400).json({ error: 'Erro ao criar meta' });
  }
});

app.put('/api/goals/:id', authenticateToken, async (req, res) => {
  const payload = { ...req.body };
  const result = parseRequest(goalSchema, payload);
  if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

  try {
    const goal = await prisma.goal.update({
      where: { id: req.params.id, userId: req.user.id },
      data: {
        title: result.data.title,
        type: req.body.type,
        targetAmount: result.data.targetAmount,
        currentAmount: req.body.currentAmount,
        deadline: new Date(result.data.deadline)
      }
    });
    res.json(goal);
  } catch (error) {
    res.status(400).json({ error: 'Erro ao atualizar meta' });
  }
});

// /api/finance/summary and /api/finance/chart have been moved to decoupled financeRoutes.js

app.get('/api/insights', authenticateToken, async (req, res) => {
  try {
    const insights = await prisma.insight.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json(insights);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar insights' });
  }
});

app.post('/api/insights/generate', authenticateToken, insightsLimiter, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { userProfile: true } });
    const transactions = await prisma.transaction.findMany({ where: { userId: req.user.id } });
    const goals = await prisma.goal.findMany({ where: { userId: req.user.id } });
    const summary = calculateSummary(user, transactions, goals);
    const profile = user.userProfile || summary.userProfile || { spendingPattern: 'controlado', riskTolerance: 'médio' };

    const topGoalStatus = summary.goalProjections[0]?.status || 'none';
    const goalMessage = summary.goalProjections.filter((g) => !g.onTrack).length > 0 ? 'behind' : 'on_track';

    // Get behavioral metrics
    const behaviorMetrics = await getEmotionalAnalyticsSummary(req.user.id);

    const tone = summary.riskLevel === 'ALTO'
      ? 'urgente e direto'
      : user.streakDays > 5
        ? 'motivador e positivo'
        : 'prático e encorajador';

    const prompt = `Você é um coach financeiro pessoal e motivador. Sempre use linguagem simples e positiva.

CONTEXTO DO USUÁRIO:
- Situação atual: ${summary.riskLevel}
- Economia mensal: ${Math.round(summary.savingsRate * 100)}%
- Maior gasto: ${summary.topSpendingCategory} (${Math.round(summary.topSpendingPercentage)}% da renda)
- Tendência: ${summary.trendDirection.toUpperCase()} ${Math.round(Math.abs(summary.trend) * 100)}%
- Meta financeira: ${goalMessage}
- Saldo atual: R$ ${summary.balance}
- Previsão de gastos: R$ ${summary.predictedExpenses}
- Perfil: ${profile.spendingPattern}
- Hábitos: ${behaviorMetrics.emotional.consistencyMessage.replace('🔥 ', '')}
- Controle: ${behaviorMetrics.emotional.preventionMessage.replace('🧠 ', '')}
- Reflexão: ${behaviorMetrics.emotional.engagementMessage.replace('🔍 ', '')}
- Tom da mensagem: ${tone}

SUA MISSÃO:
Traduza esses dados em uma mensagem clara e motivadora que ajude o usuário a melhorar.

REGRAS IMPORTANTES:
- Máximo 3 frases curtas
- Use linguagem simples e conversacional
- Destaque progresso positivo quando houver
- Evite termos técnicos financeiros
- Foque em ação prática e motivação
- Termine com uma chamada para ação positiva

EXEMPLOS DE BOAS RESPOSTAS:
"Você está controlando quase metade dos gastos impulsivos — continue assim!"
"Seu check-in diário está criando hábitos fortes — mantenha o ritmo."
"Você refletiu antes de gastar essa semana — sinal de maturidade financeira."

AGORA, CRIE UMA MENSAGEM PERSONALIZADA:`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400
    });

    const message = completion.choices[0].message.content;
    const insight = await prisma.insight.create({
      data: {
        userId: req.user.id,
        message,
        type: summary.riskLevel === 'ALTO' ? 'warning' : summary.percentageMonthUsed > 70 ? 'warning' : 'suggestion'
      }
    });

    res.json(insight);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar insight' });
  }
});

app.get('/api/score', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const transactions = await prisma.transaction.findMany({ where: { userId: req.user.id } });
    const goals = await prisma.goal.findMany({ where: { userId: req.user.id } });
    const summary = calculateSummary(user, transactions, goals);
    res.json({ score: summary.score, savingsRate: summary.savingsRate, riskLevel: summary.riskLevel });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao calcular score' });
  }
});

app.get('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { userProfile: true }
    });
    const transactions = await prisma.transaction.findMany({ where: { userId: req.user.id } });
    const goals = await prisma.goal.findMany({ where: { userId: req.user.id } });
    const summary = calculateSummary(user, transactions, goals);
    const profile = user.userProfile || {};
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      spendingPattern: profile.spendingPattern || summary.userProfile.spendingPattern,
      riskTolerance: profile.riskTolerance || summary.userProfile.riskTolerance,
      lastUpdated: profile.lastUpdated || summary.userProfile.lastUpdated,
      streakDays: user.streakDays,
      lastCheckIn: user.lastCheckIn,
      onboardingCompleted: user.onboardingCompleted,
      xp: user.xp,
      level: user.level
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar perfil do usuário' });
  }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
  const result = parseRequest(profileSchema, req.body);
  if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

  try {
    const profile = await prisma.userProfile.upsert({
      where: { userId: req.user.id },
      create: {
        userId: req.user.id,
        spendingPattern: result.data.spendingPattern,
        riskTolerance: result.data.riskTolerance,
        lastUpdated: new Date()
      },
      update: {
        spendingPattern: result.data.spendingPattern,
        riskTolerance: result.data.riskTolerance,
        lastUpdated: new Date()
      }
    });
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar perfil do usuário' });
  }
});

app.post('/api/onboarding', authenticateToken, async (req, res) => {
  const result = parseRequest(onboardingSchema, req.body);
  if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

  try {
    const { monthlyIncome, goal } = result.data;

    // 1. Update User
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        monthlyIncome,
        onboardingCompleted: true,
        xp: { increment: 50 } // Onboarding bonus
      }
    });

    // 2. Create Initial Goal
    const newGoal = await prisma.goal.create({
      data: {
        userId: req.user.id,
        title: goal.title,
        targetAmount: goal.targetAmount,
        deadline: new Date(goal.deadline),
        type: 'travel' // Default type for onboarding
      }
    });

    // 3. Create Welcome Notification
    await prisma.notification.create({
      data: {
        userId: req.user.id,
        title: '💎 Bem-vindo ao FinMind!',
        message: 'Seu perfil foi configurado. Já calculamos suas primeiras metas e o Coach está de olho!',
        type: 'achievement',
        priority: 'high'
      }
    });

    res.json({ success: true, goal: newGoal });
  } catch (error) {
    console.error('[Onboarding Error]:', error);
    res.status(500).json({ error: 'Erro ao completar onboarding' });
  }
});

app.post('/api/checkin', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const now = new Date();
    let streakDays = 1;

    if (user.lastCheckIn) {
      const diff = dayDifference(now, new Date(user.lastCheckIn));
      if (diff === 0) {
        return res.status(400).json({ error: 'Check-in já realizado hoje' });
      }
      streakDays = diff === 1 ? user.streakDays + 1 : 1;
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: { streakDays, lastCheckIn: now }
    });

    // Track daily checkin
    await trackEvent(req.user.id, 'daily_checkin');

    if (streakDays > 0 && streakDays % 7 === 0) {
      const behaviorSummary = await getEmotionalAnalyticsSummary(req.user.id);
      const preventionMessage = behaviorSummary.emotional.preventionMessage;
      await prisma.notification.create({
        data: {
          userId: req.user.id,
          title: '🔥 Conquista de Hábitos!',
          message: `${preventionMessage.replace('🧠 ', '')} — continue assim e transforme isso em rotina.`,
          type: 'achievement'
        }
      });
    }

    // Gamification Hook
    const gamification = await addXP(req.user.id, 5, `Check-in diário! Streak de ${streakDays} dias.`);

    res.json({ 
      streakDays: updatedUser.streakDays, 
      lastCheckIn: updatedUser.lastCheckIn,
      gamification 
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao registrar check-in diário' });
  }
});

app.post('/api/finance/simulate', authenticateToken, async (req, res) => {
  const payload = { ...req.body };
  const result = parseRequest(simulationSchema, payload);
  if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const transactions = await prisma.transaction.findMany({ where: { userId: req.user.id } });
    const goals = await prisma.goal.findMany({ where: { userId: req.user.id } });
    const summary = calculateSummary(user, transactions, goals);

    // Track simulation usage
    await trackEvent(req.user.id, 'simulation_used');

    const adjustedIncome = Math.max(0, user.monthlyIncome + (result.data.incomeAdjustment || 0));
    const adjustedExpenses = Math.max(0, summary.monthlyExpenses + (result.data.expenseAdjustment || 0) - (result.data.extraMonthlySavings || 0));
    const simulatedSavingsRate = adjustedIncome > 0 ? Number(((adjustedIncome - adjustedExpenses) / adjustedIncome).toFixed(2)) : 0;
    const simulatedRiskLevel = simulatedSavingsRate < 0 ? 'ALTO' : simulatedSavingsRate < 0.2 ? 'MÉDIO' : 'BAIXO';

    const baseSimulation = {
      monthlyIncome: Number(adjustedIncome.toFixed(2)),
      monthlyExpenses: Number(adjustedExpenses.toFixed(2)),
      savingsRate: simulatedSavingsRate,
      riskLevel: simulatedRiskLevel,
      projectedMonthlySavings: Number(Math.max(0, adjustedIncome - adjustedExpenses).toFixed(2)),
      predictedExpenses: Number((summary.predictedExpenses + (result.data.expenseAdjustment || 0)).toFixed(2))
    };

    let goalSimulation = null;
    const goalToSimulate = result.data.goalId ? goals.find((goal) => goal.id === result.data.goalId) : goals[0];
    if (goalToSimulate) {
      const remaining = Math.max(0, goalToSimulate.targetAmount - goalToSimulate.currentAmount);
      const monthsToGoal = baseSimulation.projectedMonthlySavings > 0
        ? Number((remaining / baseSimulation.projectedMonthlySavings).toFixed(1))
        : null;
      goalSimulation = {
        goalId: goalToSimulate.id,
        title: goalToSimulate.title,
        monthsToGoal,
        recommendedMonthlySaving: Number((remaining / Math.max(1, monthsToGoal || 1)).toFixed(2))
      };
    }

    res.json({
      scenario: result.data,
      simulation: baseSimulation,
      goalSimulation
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar simulação financeira' });
  }
});

app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar notificações' });
  }
});

app.put('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const notification = await prisma.notification.update({
      where: { id: req.params.id },
      data: { read: true }
    });
    res.json(notification);
  } catch (error) {
    res.status(400).json({ error: 'Erro ao marcar notificação como lida' });
  }
});

app.get('/api/patterns', authenticateToken, async (req, res) => {
  try {
    const patterns = await prisma.patternAlert.findMany({
      where: { userId: req.user.id },
      orderBy: { detectedAt: 'desc' }
    });
    res.json(patterns);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar padrões' });
  }
});

app.post('/api/daily-analysis-trigger', authenticateToken, async (req, res) => {
  if (process.env.ADMIN_TOKEN !== req.header('x-admin-token')) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  
  try {
    await runDailyAnalysis();
    res.json({ message: 'Análise diária executada com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao executar análise diária' });
  }
});

app.get('/api/analytics/emotional', authenticateToken, async (req, res) => {
  try {
    const summary = await getEmotionalAnalyticsSummary(req.user.id);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar análise comportamental' });
  }
});

// Analytics routes
app.post('/api/analytics/track', authenticateToken, async (req, res) => {
  const { type, category, data } = req.body;
  if (!type) return res.status(400).json({ error: 'Tipo de evento obrigatório' });

  try {
    await trackEvent(req.user.id, type, category, data);

    // Gamification for intelligent behavior
    if (type === 'transaction_warning_cancelled') {
        await addXP(req.user.id, 15, 'Decisão consciente: você evitou um gasto impulsivo após o alerta!');
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao registrar evento' });
  }
});

app.post('/api/transactions/cancel', authenticateToken, async (req, res) => {
  const { category, amount, reason } = req.body;
  
  try {
    // Track cancellation after warning
    await trackEvent(req.user.id, 'transaction_cancelled_after_warning', category, {
      amount,
      reason
    });
    
    res.json({ success: true, message: 'Transação cancelada com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao cancelar transação' });
  }
});

app.post('/api/transactions/alternative', authenticateToken, async (req, res) => {
  const { category, alternativeType } = req.body;
  
  try {
    // Track alternative selection
    await trackEvent(req.user.id, 'alternative_selected', category, {
      alternativeType
    });
    
    res.json({ success: true, message: 'Alternativa registrada' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao registrar alternativa' });
  }
});

app.get('/api/analytics/summary', authenticateToken, async (req, res) => {
  try {
    const summary = await getEmotionalAnalyticsSummary(req.user.id);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar resumo analítico' });
  }
});

app.get('/api/analytics/weekly-summary', authenticateToken, async (req, res) => {
  try {
    const summary = await getEmotionalAnalyticsSummary(req.user.id);
    const weeklySummary = summary.emotional.weeklySummary;
    res.json(weeklySummary);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar resumo semanal' });
  }
});

app.get('/api/analytics/badges', authenticateToken, async (req, res) => {
  try {
    const summary = await getEmotionalAnalyticsSummary(req.user.id);
    const badges = summary.emotional.badges;
    res.json(badges);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar badges' });
  }
});

app.get('/api/analytics/timeline', authenticateToken, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const timeline = await getPersonalTimeline(req.user.id, days);
    res.json(timeline);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar timeline pessoal' });
  }
});

// 🚀 Global Error Handler (SaaS Safety Net)
app.use((err, req, res, next) => {
  console.error(`[Global Error]: ${err.stack}`);
  res.status(err.status || 500).json({
    error: 'Erro interno no servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Algo deu errado. Tente novamente mais tarde.'
  });
});

const PORT = process.env.PORT || 5000;

// 🚨 Error Handlers (Production Safety)
process.on('uncaughtException', (err) => {
  console.error('❌ [CRITICAL] Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

async function startServer() {
  try {
    console.log('🚀 Iniciando FinMind API...');
    console.log(`📍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📍 Versão: 1.0.0`);
    
    await prisma.$connect();
    console.log('✅ Conexão com o banco de dados PostgreSQL estabelecida.');
    
    app.listen(PORT, () => {
      console.log('--------------------------------------------------');
      console.log(`🚀 FinMind API iniciada com sucesso!`);
      console.log(`📍 Porta: ${PORT}`);
      console.log(`📍 Health Check: /api/health`);
      console.log('--------------------------------------------------');
      startDailyAnalysisJob();
      startNotificationScheduler();
    });
  } catch (error) {
    console.error('❌ ERRO CRÍTICO: Não foi possível conectar ao banco de dados.');
    console.error(error);
    process.exit(1);
  }
}

startServer();
