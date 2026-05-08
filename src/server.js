/**
 * FinMind API — server.js
 * Versão: PATCHED (Auditoria de Segurança)
 *
 * Correções aplicadas:
 *  1. Guard obrigatório de variáveis de ambiente com process.exit(1)
 *  2. helmet.js para headers de segurança HTTP
 *  3. trust proxy configurado para Render
 *  4. CORS: removido wildcard .vercel.app, lista explícita
 *  5. Rate limiting de auth reduzido para 10 tentativas / 15min
 *  6. GOOGLE_CLIENT_SECRET adicionado ao guard de ENV
 *  7. Health check com query real ao banco (já estava correto — mantido)
 *  8. Sem alterações de rotas ou lógica de negócio
 */

'use strict';

const dotenv = require('dotenv');
dotenv.config();

// ─────────────────────────────────────────────────────────────
// 1. GUARD OBRIGATÓRIO DE VARIÁVEIS DE AMBIENTE
//    Deve rodar ANTES de qualquer import que leia process.env
// ─────────────────────────────────────────────────────────────
const REQUIRED_ENV = [
  'DATABASE_URL',
  'JWT_SECRET',
  'NODE_ENV',
  'FRONTEND_URL',
  'GOOGLE_CLIENT_ID_WEB',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CALLBACK_URL',
];

const PLACEHOLDER_PATTERNS = [
  'your_',
  'change_this',
  'secret_here',
  'your-',
  '<',
  'CHANGEME',
];

const envErrors = [];

for (const key of REQUIRED_ENV) {
  const val = process.env[key];
  if (!val || val.trim() === '') {
    envErrors.push(`  ✗ ${key}: ausente`);
    continue;
  }
  const isPlaceholder = PLACEHOLDER_PATTERNS.some(p =>
    val.toLowerCase().includes(p.toLowerCase())
  );
  if (isPlaceholder) {
    envErrors.push(`  ✗ ${key}: contém valor placeholder ("${val.slice(0, 30)}...")`);
  }
}

if (envErrors.length > 0) {
  console.error('\n╔══════════════════════════════════════════════════╗');
  console.error('║  ERRO CRÍTICO DE CONFIGURAÇÃO — STARTUP ABORTADO  ║');
  console.error('╚══════════════════════════════════════════════════╝');
  envErrors.forEach(e => console.error(e));
  console.error('\nConfigure todas as variáveis obrigatórias antes de iniciar.\n');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// 2. IMPORTS
// ─────────────────────────────────────────────────────────────
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const prisma       = require('../prisma/client');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const OpenAI       = require('openai');
const rateLimit    = require('express-rate-limit');
const { z }        = require('zod');
const crypto       = require('crypto');
const axios        = require('axios');
const cron         = require('node-cron');

const { calculateSummary }                    = require('./engine/financialEngine');
const { startDailyAnalysisJob, runDailyAnalysis } = require('./jobs/dailyAnalysisJob');
const { startNotificationScheduler }          = require('./engine/notificationScheduler');
const {
  trackEvent,
  getAnalyticsSummary,
  getEmotionalAnalyticsSummary,
  getPersonalTimeline,
} = require('./analytics/behaviorMetrics');
const { addXP }                               = require('./services/gamificationService');
const { loadUserById, tenantWhere }           = require('./services/tenantService');
const { trackTelemetry }                      = require('./services/telemetryService');
const { verifyGoogleToken, findOrCreateGoogleUser } = require('./services/googleAuth');
const { runGrowthEngine }                     = require('./services/growthEngineService');

const financeRoutes    = require('./routes/financeRoutes');
const adminRoutes      = require('./routes/adminRoutes');
const growthRoutes     = require('./routes/growthRoutes');
const authRoutes       = require('./routes/authRoutes');
const usageLimiter     = require('./middleware/usageLimiter');
const requestLogger    = require('./middleware/requestLogger');
const errorHandler     = require('./middleware/errorHandler');
const lightCache       = require('./middleware/cache');
const { authenticateToken } = require('./middleware/auth');

// ─────────────────────────────────────────────────────────────
// 3. INICIALIZAÇÃO DO APP
// ─────────────────────────────────────────────────────────────
const app = express();

// Trust proxy: obrigatório para Render (Nginx reverso)
// Garante que req.ip retorne o IP real do cliente (rate limiting correto)
app.set('trust proxy', 1);

// ─────────────────────────────────────────────────────────────
// 4. HELMET — Headers de segurança HTTP
// ─────────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginEmbedderPolicy: false, // Necessário para Vercel iframes se usado
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'"],
        styleSrc:   ["'self'", "'unsafe-inline'"],
        imgSrc:     ["'self'", 'data:', 'https:'],
      },
    },
  })
);

// ─────────────────────────────────────────────────────────────
// 5. CORS — Lista explícita e segura
//    REMOVIDO: wildcard .vercel.app (qualquer subdomínio vercel era permitido)
// ─────────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:19006', // Expo web
  process.env.FRONTEND_URL,
  // Adicionar outros domínios de produção explicitamente aqui
  // NÃO usar *.vercel.app — permite que qualquer deploy vercel acesse sua API
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // Sem origin: mobile nativo (Expo/React Native), Postman, cURL — permitir
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`[SECURITY][CORS] Origem bloqueada: ${origin}`);
    return callback(new Error('Acesso não permitido por política de CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
};

app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' })); // Limite de payload

// ─────────────────────────────────────────────────────────────
// 6. RATE LIMITING
//    authLimiter: 10 tentativas / 15min (CORRIGIDO — era 100)
//    insightsLimiter: mantido
// ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,                   // CORRIGIDO: era 100, reduzido para 10
  message: {
    error: 'Muitas tentativas de autenticação. Tente novamente em 15 minutos.',
    code:  'RATE_LIMIT_AUTH',
  },
  standardHeaders: true,
  legacyHeaders:   false,
  // Usar IP real após trust proxy
  keyGenerator: (req) => req.ip,
});

const insightsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // CORRIGIDO: era 100, reduzido para valor razoável
  message: {
    error: 'Muitas solicitações de insights. Aguarde um momento.',
    code:  'RATE_LIMIT_INSIGHTS',
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

// Aplicar rate limit específico nas rotas de auth
app.use('/api/v1/auth/login',    authLimiter);
app.use('/api/v1/auth/register', authLimiter);

// ─────────────────────────────────────────────────────────────
// 7. OPENAI — Fallback gracioso se não configurado
// ─────────────────────────────────────────────────────────────
const openaiApiKey    = process.env.OPENAI_API_KEY?.trim();
const openai          = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
const isOpenAIConfigured = Boolean(openaiApiKey);

if (!isOpenAIConfigured) {
  console.warn('[WARN] OPENAI_API_KEY não configurada. Features de IA desabilitadas.');
}

// ─────────────────────────────────────────────────────────────
// 8. MIDDLEWARES GLOBAIS
// ─────────────────────────────────────────────────────────────
app.use(requestLogger);

// ─────────────────────────────────────────────────────────────
// 9. HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const health = {
    success:   true,
    status:    'ok',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV,
    checks:    { database: 'down', openai: 'down' },
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    health.checks.database = 'connected';
  } catch {
    health.success         = false;
    health.status          = 'error';
    health.checks.database = 'error';
  }

  try {
    if (openai) {
      await openai.models.list();
      health.checks.openai = 'connected';
    } else {
      health.checks.openai = 'not_configured';
    }
  } catch {
    health.checks.openai = 'error';
  }

  res.status(health.success ? 200 : 503).json(health);
});

// ─────────────────────────────────────────────────────────────
// 10. SCHEMAS ZOD
// ─────────────────────────────────────────────────────────────
const registerSchema = z.object({
  name:          z.string().min(2),
  email:         z.string().email(),
  password:      z.string().min(6),
  monthlyIncome: z.number().nonnegative().optional().default(0),
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(6),
});

const transactionSchema = z.object({
  type:           z.enum(['income', 'expense']),
  category:       z.string().min(1),
  amount:         z.number().positive(),
  date:           z.string().optional(),
  description:    z.string().optional(),
  confirmWarning: z.boolean().optional(),
});

const goalSchema = z.object({
  title:        z.string().min(1),
  targetAmount: z.number().positive(),
  deadline:     z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Data inválida' }),
});

const profileSchema = z.object({
  spendingPattern: z.enum(['impulsivo', 'planejador', 'controlado']),
  riskTolerance:   z.enum(['alto', 'médio', 'baixo']),
});

const simulationSchema = z.object({
  incomeAdjustment:    z.number().optional(),
  expenseAdjustment:   z.number().optional(),
  extraMonthlySavings: z.number().optional(),
  goalId:              z.string().optional(),
});

const onboardingSchema = z.object({
  monthlyIncome: z.number().positive(),
  goal: z.object({
    title:        z.string().min(1),
    targetAmount: z.number().positive(),
    deadline:     z.string(),
  }),
});

const parseRequest = (schema, data) => {
  try {
    return { success: true, data: schema.parse(data) };
  } catch (error) {
    return { success: false, errors: error.errors.map((e) => e.message) };
  }
};

// ─────────────────────────────────────────────────────────────
// 11. UTILITÁRIOS
// ─────────────────────────────────────────────────────────────
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayDifference(dateA, dateB) {
  return Math.round((startOfDay(dateA) - startOfDay(dateB)) / (1000 * 60 * 60 * 24));
}

// ─────────────────────────────────────────────────────────────
// 12. V1 ROUTER — Rotas de negócio (inalteradas funcionalmente)
// ─────────────────────────────────────────────────────────────
const v1Router = express.Router();

v1Router.use('/finance', financeRoutes);
v1Router.use('/admin',   adminRoutes);
v1Router.use('/growth',  growthRoutes);

// --- User ---
v1Router.delete('/user/me', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    console.log(`⚠️ DELEÇÃO DE CONTA: Usuário ${userId}`);
    await prisma.user.delete({ where: { id: userId } });
    res.json({ success: true, message: 'Conta excluída permanentemente.' });
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
      data:  { xp: 0, level: 1, streakDays: 0, lastCheckIn: null },
    });
    res.json({ message: 'Dados resetados com sucesso.' });
  } catch (error) {
    next(error);
  }
});

// --- Transactions ---
v1Router.get('/transactions', authenticateToken, async (req, res, next) => {
  try {
    const transactions = await prisma.transaction.findMany({
      where: { ...tenantWhere(req.user) },
    });
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
      date:   req.body.date ? new Date(req.body.date) : new Date(),
    };
    const result = parseRequest(transactionSchema, payload);
    if (!result.success)
      return res.status(400).json({ error: result.errors.join(', ') });

    const { confirmWarning, ...txData } = result.data;
    const transaction = await prisma.transaction.create({
      data: { ...txData, userId: req.user.id },
    });
    res.json(transaction);
  } catch (error) {
    next(error);
  }
});

v1Router.delete('/transactions/:id', authenticateToken, async (req, res, next) => {
  try {
    await prisma.transaction.deleteMany({
      where: { id: req.params.id, ...tenantWhere(req.user) },
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// --- Goals ---
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
    if (!result.success)
      return res.status(400).json({ error: result.errors.join(', ') });

    const goal = await prisma.goal.create({
      data: {
        ...result.data,
        deadline: new Date(result.data.deadline),
        userId:   req.user.id,
      },
    });
    res.json(goal);
  } catch (error) {
    next(error);
  }
});

// --- Finance ---
v1Router.get('/finance/summary', authenticateToken, lightCache(60), async (req, res, next) => {
  try {
    const user         = await prisma.user.findUnique({ where: { id: req.user.id } });
    const transactions = await prisma.transaction.findMany({ where: { ...tenantWhere(req.user) } });
    const goals        = await prisma.goal.findMany({ where: { ...tenantWhere(req.user) } });
    const summary      = calculateSummary(user, transactions, goals);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

v1Router.post('/finance/simulate', authenticateToken, async (req, res, next) => {
  try {
    const result = parseRequest(simulationSchema, req.body);
    if (!result.success)
      return res.status(400).json({ error: result.errors.join(', ') });

    const user         = await prisma.user.findUnique({ where: { id: req.user.id } });
    const transactions = await prisma.transaction.findMany({ where: { ...tenantWhere(req.user) } });
    const goals        = await prisma.goal.findMany({ where: { ...tenantWhere(req.user) } });
    const summary      = calculateSummary(user, transactions, goals);

    const adjustedIncome   = Math.max(0, user.monthlyIncome + (result.data.incomeAdjustment || 0));
    const adjustedExpenses = Math.max(0, summary.monthlyExpenses + (result.data.expenseAdjustment || 0));
    const simulatedSavingsRate =
      adjustedIncome > 0 ? (adjustedIncome - adjustedExpenses) / adjustedIncome : 0;

    res.json({
      simulation: {
        monthlyIncome:  adjustedIncome,
        monthlyExpenses: adjustedExpenses,
        savingsRate:    simulatedSavingsRate,
      },
    });
  } catch (error) {
    next(error);
  }
});

// --- Notifications ---
v1Router.get('/notifications', authenticateToken, async (req, res, next) => {
  try {
    const notifications = await prisma.notification.findMany({
      where:   { ...tenantWhere(req.user) },
      orderBy: { createdAt: 'desc' },
      take:    20,
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
      data:  { read: true },
    });
    const notification = await prisma.notification.findFirst({
      where: { id: req.params.id, ...tenantWhere(req.user) },
    });
    res.json(notification);
  } catch (error) {
    next(error);
  }
});

// --- Analytics ---
v1Router.get(
  '/analytics/emotional',
  authenticateToken,
  usageLimiter('emotional_analytics'),
  lightCache(60),
  async (req, res, next) => {
    try {
      const summary = await getEmotionalAnalyticsSummary(req.user.id);
      res.json(summary);
    } catch (error) {
      next(error);
    }
  }
);

v1Router.post('/analytics/track', authenticateToken, async (req, res, next) => {
  try {
    await trackTelemetry(req.user.id, req.body.type, {
      category: req.body.category,
      ...req.body.data,
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

v1Router.get('/analytics/growth-actions', authenticateToken, async (req, res, next) => {
  try {
    const actions = await prisma.growthAction.findMany({
      where:   { userId: req.user.id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
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
      data:  { status },
    });
    res.json({ success: true, action });
  } catch (error) {
    next(error);
  }
});

// Endpoint público (sem auth) para telemetria de visitantes
v1Router.post('/analytics/track-public', async (req, res, next) => {
  try {
    const { type, metadata } = req.body;
    // Sanitizar: apenas tipos de evento conhecidos
    const allowedTypes = [
      'page_view', 'landing_view', 'cta_click', 'auth_started',
    ];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: 'Tipo de evento não permitido' });
    }
    await trackTelemetry(null, type, metadata);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// --- Jobs ---
v1Router.post('/jobs/run-daily', async (req, res, next) => {
  if (process.env.ADMIN_TOKEN !== req.header('x-admin-token')) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  try {
    await runDailyAnalysis();
    res.json({ success: true, message: 'Análise diária executada.' });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────
// 13. MONTAGEM DAS ROTAS
// ─────────────────────────────────────────────────────────────
// Auth montada diretamente para garantir /api/v1/auth/*
app.use('/api/v1', authRoutes);
console.log('📌 Auth routes mounted at /api/v1/auth/*');

// Demais rotas
app.use('/api/v1', v1Router);

// ─────────────────────────────────────────────────────────────
// 14. GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─────────────────────────────────────────────────────────────
// 15. PROCESS ERROR HANDLERS
// ─────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('❌ [CRITICAL] Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ [CRITICAL] Unhandled Rejection:', reason);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────
// 16. STARTUP
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    console.log('🚀 Iniciando FinMind API...');
    console.log(`📍 Ambiente: ${process.env.NODE_ENV}`);

    await prisma.$connect();
    console.log('✅ Conexão com PostgreSQL estabelecida.');

    app.listen(PORT, () => {
      console.log('──────────────────────────────────────');
      console.log(`🚀 FinMind API iniciada na porta ${PORT}`);
      console.log(`📍 Health: /api/health`);
      console.log('──────────────────────────────────────');

      startDailyAnalysisJob();
      startNotificationScheduler();

      console.log('[GROWTH] Agendando motor de automação...');
      cron.schedule('0 */4 * * *', async () => {
        try {
          await runGrowthEngine();
        } catch (err) {
          console.error('[GROWTH ERROR]', err);
        }
      });

      setTimeout(() => {
        runGrowthEngine().catch(console.error);
      }, 60_000);
    });
  } catch (error) {
    console.error('❌ ERRO CRÍTICO NO STARTUP:', error.message);
    if (error.code) console.error('Código Prisma:', error.code);
    console.error(error.stack);
    process.exit(1);
  }
}

startServer();
