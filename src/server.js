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
const { loadUserById, tenantWhere } = require('./services/tenantService');
const { trackTelemetry } = require('./services/telemetryService');
const financeRoutes = require('./routes/financeRoutes');
const adminRoutes = require('./routes/adminRoutes');
const growthRoutes = require('./routes/growthRoutes');
const authRoutes = require('./routes/authRoutes');
const { runGrowthEngine } = require('./services/growthEngineService');
const cron = require('node-cron');
const usageLimiter = require('./middleware/usageLimiter');
const crypto = require('crypto');
const { verifyGoogleToken, findOrCreateGoogleUser } = require('./services/googleAuth');
const axios = require('axios');
dotenv.config();

// 🚀 VALIDAÇÃO CRÍTICA DE STARTUP
const requiredEnv = ['DATABASE_URL', 'JWT_SECRET', 'NODE_ENV'];
const missingEnv = requiredEnv.filter(env => !process.env[env]);
if (missingEnv.length > 0) {
  console.error('\n❌ ERRO CRÍTICO DE CONFIGURAÇÃO:');
  console.error(`As seguintes variáveis de ambiente são obrigatórias: ${missingEnv.join(', ')}`);
  console.error('Abortando inicialização do servidor...\n');
  process.exit(1);
}

const app = express();
const { authenticateToken } = require('./middleware/auth');

// prisma instance is now imported from prisma/client
const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
const isOpenAIConfigured = Boolean(openaiApiKey);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // Ajustado ligeiramente
  message: { error: 'Muitas tentativas de autenticação, tente novamente em 15 minutos.' }
});

const insightsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Muitas solicitações de insights, aguarde um minuto.' }
});

// URLs permitidas — Agora mais robusto para produção
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:19006',
  'https://finan-as-pessoais-seven.vercel.app',
  'https://finmind.vercel.app', // Novo domínio sugerido
  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // Sem origin → Mobile apps ou ferramentas de teste locais → OK
    if (!origin) return callback(null, true);

    // Permitir qualquer subdomínio do Vercel (Preview Deploys)
    if (origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`[SECURITY] Bloqueio de CORS para origem não autorizada: ${origin}`);
    return callback(new Error('Acesso não permitido por política de CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token']
};

// Preflight e Middleware CORS
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json());

const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const lightCache = require('./middleware/cache');

// 📊 LOGS ESTRUTURADOS (Primeiro middleware para capturar tudo)
app.use(requestLogger);

// 🩺 Health Check & Diagnostics (Sem autenticação por ser endpoint de infra)
app.get('/api/health', async (req, res) => {
  const health = { 
    success: true,
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    checks: {
      database: 'down',
      openai: 'down'
    }
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    health.checks.database = 'connected';
  } catch (error) {
    health.success = false;
    health.status = 'error';
    health.checks.database = 'error';
  }

  try {
    if (openai) {
      // Teste leve de conectividade
      await openai.models.list();
      health.checks.openai = 'connected';
    } else {
      health.checks.openai = 'not_configured';
    }
  } catch (error) {
    health.checks.openai = 'error';
  }

  const statusCode = health.success ? 200 : 503;
  res.status(statusCode).json(health);
});

// 🚀 API VERSIONING (v1)
const v1Router = express.Router();

// Modular Routes
v1Router.use('/finance', financeRoutes);
v1Router.use('/admin', adminRoutes);
v1Router.use('/growth', growthRoutes);
v1Router.use('/auth', authRoutes);


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



v1Router.delete('/user/me', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    console.log(`⚠️ DELEÇÃO DE CONTA: Usuário ${userId} solicitou exclusão permanente.`);
    await prisma.user.delete({
      where: { id: userId }
    });
    res.json({ success: true, message: 'Sua conta e todos os seus dados foram excluídos permanentemente.' });
  } catch (error) {
    next(error);
  }
});

v1Router.get('/transactions', authenticateToken, async (req, res, next) => {
  try {
    const transactions = await prisma.transaction.findMany({ where: { ...tenantWhere(req.user) } });
    res.json(transactions);
  } catch (error) {
    next(error);
  }
});

v1Router.post('/transactions', authenticateToken, async (req, res, next) => {
  try {
    const payload = {
      ...req.body,
      amount: Number(req.body.amount),
      date: req.body.date || new Date().toISOString(),
      confirmWarning: req.body.confirmWarning === true
    };
    const result = parseRequest(transactionSchema, payload);
    if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

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

    if (warningThreshold && !result.data.confirmWarning) {
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
        currentCategoryTotal: Number(categoryExpenses.toFixed(2))
      });
    }

    const xpReward = 10;

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

    if (result.data.confirmWarning) {
      await trackEvent(req.user.id, 'transaction_confirmed_anyway', result.data.category, {
        amount: result.data.amount
      });
    }

    const gamification = await addXP(req.user.id, xpReward, result.data.type === 'income' ? 'Nova receita registrada' : 'Gasto registrado com sucesso');

    // Telemetria: Transação
    await trackTelemetry(req.user.id, 'transaction_created', { 
      type: result.data.type, 
      category: result.data.category, 
      amount: result.data.amount 
    });

    // Ativação: Primeira Transação
    const txCount = await prisma.transaction.count({ where: { userId: req.user.id } });
    if (txCount === 1) {
      await trackTelemetry(req.user.id, 'first_transaction_created');
    }

    res.json({ transaction, gamification });
  } catch (error) {
    next(error);
  }
});

v1Router.delete('/transactions/:id', authenticateToken, async (req, res, next) => {
  try {
    await prisma.transaction.delete({
      where: { id: req.params.id, userId: req.user.id }
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

v1Router.get('/goals', authenticateToken, async (req, res, next) => {
  try {
    const goals = await prisma.goal.findMany({ where: { ...tenantWhere(req.user) } });
    res.json(goals);
  } catch (error) {
    next(error);
  }
});

v1Router.post('/goals', authenticateToken, async (req, res, next) => {
  try {
    const result = parseRequest(goalSchema, req.body);
    if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

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

    await addXP(req.user.id, 20, `Novo objetivo planejado: ${goal.title}`);
    res.json(goal);
  } catch (error) {
    next(error);
  }
});

v1Router.put('/goals/:id', authenticateToken, async (req, res, next) => {
  try {
    const result = parseRequest(goalSchema, req.body);
    if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

    const goal = await prisma.goal.update({
      where: { id: req.params.id, ...tenantWhere(req.user) },
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
    next(error);
  }
});

// /api/finance/summary and /api/finance/chart have been moved to decoupled financeRoutes.js

v1Router.get('/insights', authenticateToken, usageLimiter('insights'), lightCache(60), async (req, res, next) => {
  try {
    const insights = await prisma.insight.findMany({
      where: { ...tenantWhere(req.user) },
      orderBy: { createdAt: 'desc' }
    });
    res.json(insights);
  } catch (error) {
    next(error);
  }
});

v1Router.post('/insights/generate', authenticateToken, usageLimiter('insights_generate'), insightsLimiter, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { userProfile: true } });
    const transactions = await prisma.transaction.findMany({ where: { ...tenantWhere(req.user) } });
    const goals = await prisma.goal.findMany({ where: { ...tenantWhere(req.user) } });
    const summary = calculateSummary(user, transactions, goals);
    const profile = user.userProfile || summary.userProfile || { spendingPattern: 'controlado', riskTolerance: 'médio' };

    const behaviorMetrics = await getEmotionalAnalyticsSummary(req.user.id);

    const tone = summary.riskLevel === 'ALTO'
      ? 'urgente e direto'
      : user.streakDays > 5
        ? 'motivador e positivo'
        : 'prático e encorajador';

    const prompt = `Você é um coach financeiro pessoal e motivador. Traduza os dados em uma mensagem curta (máx 3 frases) e motivadora.
DADOS: Risco ${summary.riskLevel}, Economia ${Math.round(summary.savingsRate * 100)}%, Top Categoria ${summary.topSpendingCategory}, Saldo R$ ${summary.balance}.
Tom: ${tone}.`;

    if (!openai) {
      return res.status(503).json({ error: 'Serviço de IA indisponível' });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200
    });

    const message = completion.choices[0].message.content;
    const insight = await prisma.insight.create({
      data: {
        userId: req.user.id,
        message,
        type: summary.riskLevel === 'ALTO' ? 'warning' : 'suggestion'
      }
    });

    // Telemetria: Insight Gerado
    await trackTelemetry(req.user.id, 'insight_generated', { type: insight.type });

    // Ativação: Primeiro Insight
    const insightCount = await prisma.insight.count({ where: { userId: req.user.id } });
    if (insightCount === 1) {
      await trackTelemetry(req.user.id, 'first_insight_generated');
    }

    res.json(insight);
  } catch (error) {
    next(error);
  }
});

v1Router.get('/score', authenticateToken, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const transactions = await prisma.transaction.findMany({ where: { ...tenantWhere(req.user) } });
    const goals = await prisma.goal.findMany({ where: { ...tenantWhere(req.user) } });
    const summary = calculateSummary(user, transactions, goals);
    res.json({ score: summary.score, savingsRate: summary.savingsRate, riskLevel: summary.riskLevel });
  } catch (error) {
    next(error);
  }
});

v1Router.get('/users/profile', authenticateToken, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { userProfile: true }
    });
    const profile = user.userProfile || {};
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      spendingPattern: profile.spendingPattern,
      riskTolerance: profile.riskTolerance,
      streakDays: user.streakDays,
      xp: user.xp,
      level: user.level
    });
  } catch (error) {
    next(error);
  }
});

v1Router.put('/users/profile', authenticateToken, async (req, res, next) => {
  try {
    const result = parseRequest(profileSchema, req.body);
    if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

    const profile = await prisma.userProfile.upsert({
      where: { ...tenantWhere(req.user) },
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
    next(error);
  }
});

v1Router.post('/onboarding', authenticateToken, async (req, res, next) => {
  try {
    const result = parseRequest(onboardingSchema, req.body);
    if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        monthlyIncome: result.data.monthlyIncome,
        onboardingCompleted: true,
        xp: { increment: 50 }
      }
    });

    const newGoal = await prisma.goal.create({
      data: {
        userId: req.user.id,
        ...result.data.goal,
        type: 'travel'
      }
    });

    res.json({ success: true, goal: newGoal });
  } catch (error) {
    next(error);
  }
});

v1Router.post('/checkin', authenticateToken, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const now = new Date();
    let streakDays = 1;

    if (user.lastCheckIn && dayDifference(now, new Date(user.lastCheckIn)) === 0) {
      return res.status(400).json({ error: 'Check-in já realizado hoje' });
    }

    if (user.lastCheckIn && dayDifference(now, new Date(user.lastCheckIn)) === 1) {
      streakDays = user.streakDays + 1;
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: { streakDays, lastCheckIn: now }
    });

    await trackEvent(req.user.id, 'daily_checkin');
    const gamification = await addXP(req.user.id, 5, `Check-in diário! Streak de ${streakDays} dias.`);

    res.json({ 
      streakDays: updatedUser.streakDays, 
      gamification 
    });
  } catch (error) {
    next(error);
  }
});

v1Router.post('/finance/simulate', authenticateToken, async (req, res, next) => {
  try {
    const result = parseRequest(simulationSchema, req.body);
    if (!result.success) return res.status(400).json({ error: result.errors.join(', ') });

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const transactions = await prisma.transaction.findMany({ where: { ...tenantWhere(req.user) } });
    const goals = await prisma.goal.findMany({ where: { ...tenantWhere(req.user) } });
    const summary = calculateSummary(user, transactions, goals);

    const adjustedIncome = Math.max(0, user.monthlyIncome + (result.data.incomeAdjustment || 0));
    const adjustedExpenses = Math.max(0, summary.monthlyExpenses + (result.data.expenseAdjustment || 0));
    const simulatedSavingsRate = adjustedIncome > 0 ? (adjustedIncome - adjustedExpenses) / adjustedIncome : 0;

    res.json({
      simulation: {
        monthlyIncome: adjustedIncome,
        monthlyExpenses: adjustedExpenses,
        savingsRate: simulatedSavingsRate
      }
    });
  } catch (error) {
    next(error);
  }
});

v1Router.get('/notifications', authenticateToken, async (req, res, next) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { ...tenantWhere(req.user) },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    res.json(notifications);
  } catch (error) {
    next(error);
  }
});

v1Router.put('/notifications/:id/read', authenticateToken, async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params.id, ...tenantWhere(req.user) },
      data: { read: true }
    });

    const notification = await prisma.notification.findFirst({
      where: { id: req.params.id, ...tenantWhere(req.user) }
    });

    res.json(notification);
  } catch (error) {
    next(error);
  }
});

v1Router.get('/analytics/emotional', authenticateToken, usageLimiter('emotional_analytics'), lightCache(60), async (req, res, next) => {
  try {
    const summary = await getEmotionalAnalyticsSummary(req.user.id);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

v1Router.post('/analytics/track', authenticateToken, async (req, res, next) => {
  try {
    await trackTelemetry(req.user.id, req.body.type, { 
        category: req.body.category, 
        ...req.body.data 
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

v1Router.get('/analytics/growth-actions', authenticateToken, async (req, res, next) => {
  try {
    const actions = await prisma.growthAction.findMany({
      where: { userId: req.user.id, status: 'pending' },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ actions });
  } catch (error) {
    next(error);
  }
});

v1Router.put('/analytics/growth-actions/:id', authenticateToken, async (req, res, next) => {
  try {
    const { status } = req.body;
    const action = await prisma.growthAction.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data: { status }
    });
    res.json({ success: true, action });
  } catch (error) {
    next(error);
  }
});

v1Router.post('/analytics/track-public', async (req, res, next) => {
  try {
    const { type, metadata } = req.body;
    await trackTelemetry(null, type, metadata);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

v1Router.delete('/user/reset', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.goal.deleteMany({ where: { userId } });
    await prisma.insight.deleteMany({ where: { userId } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.user.update({
      where: { id: userId },
      data: { xp: 0, level: 1, streakDays: 0, lastCheckIn: null }
    });
    res.json({ message: 'Seus dados foram resetados com sucesso.' });
  } catch (error) {
    next(error);
  }
});

// 🚀 Manual Job Trigger (Render safe)
v1Router.post('/jobs/run-daily', async (req, res, next) => {
  if (process.env.ADMIN_TOKEN !== req.header('x-admin-token')) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  try {
    await runDailyAnalysis();
    res.json({ success: true, message: 'Análise diária executada com sucesso' });
  } catch (error) {
    next(error);
  }
});

// 🚀 MOUNT API ROUTES (v1)
// We mount here at the end to ensure all routes on v1Router are registered
app.use('/api/v1', v1Router);

// 🚨 Global Error Handler (SaaS Safety Net)
app.use(errorHandler);

const PORT = process.env.PORT || 3001;

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
      
      // 🚀 GROWTH ENGINE SCHEDULER (Batch Process)
      console.log('[GROWTH] Agendando motor de automação (Shadow Mode)...');
      cron.schedule('0 */4 * * *', async () => { 
        try {
          const { runGrowthEngine } = require('./services/growthEngineService');
          await runGrowthEngine();
        } catch (err) {
          console.error('[GROWTH ERROR] Falha na execução agendada:', err);
        }
      });
      
      // Execução inicial após 1 minuto (shadow validation)
      setTimeout(() => {
        const { runGrowthEngine } = require('./services/growthEngineService');
        runGrowthEngine().catch(console.error);
      }, 60000);
    });
  } catch (error) {
    console.error('❌ ERRO CRÍTICO NO STARTUP:');
    console.error('Mensagem:', error.message);
    if (error.code) console.error('Código Prisma:', error.code);
    console.error('Trace:', error.stack);
    process.exit(1);
  }
}

startServer();
