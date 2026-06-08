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
  // [GATE-1/OF-021] Open Finance (Pluggy) — fail-fast no boot.
  // Sem estas o OF falha tardiamente em runtime: API Pluggy (CLIENT_ID/SECRET),
  // cifra de pluggyItemId (ENCRYPTION_KEY), webhook fail-closed rejeitando tudo
  // (WEBHOOK_SECRET) e registro de webhook (WEBHOOK_URL).
  'PLUGGY_CLIENT_ID',
  'PLUGGY_CLIENT_SECRET',
  'PLUGGY_WEBHOOK_SECRET',
  'PLUGGY_WEBHOOK_URL',
  'ENCRYPTION_KEY',
];

const PLACEHOLDER_PATTERNS = [
  'your_',
  'change_this',
  'secret_here',
  'your-',
  '<',
  'CHANGEME',
  // [CRÍTICO-2] Detectar secrets fracos conhecidos
  'supersecret',
  'admin_secret',
  'password',
  '12345',
  'secret123',
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
const cookieParser = require('cookie-parser'); // [CRÍTICO-1] Necessário para OAuth CSRF state
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
const { hasActiveTemporaryAI, canUseAI }      = require('./services/aiAccess'); // [FASE 3.4/3.5]
const { generateInsight }                     = require('./services/insightGenerator'); // [FASE 3.5]
const { verifyGoogleToken, findOrCreateGoogleUser } = require('./services/googleAuth');
const { runGrowthEngine }                     = require('./services/growthEngineService');

const financeRoutes       = require('./routes/financeRoutes');
const adminRoutes         = require('./routes/adminRoutes');
const growthRoutes        = require('./routes/growthRoutes');
const authRoutes          = require('./routes/authRoutes');
const openFinanceRoutes   = require('./routes/openFinanceRoutes');
const pluggyWebhookRoutes = require('./routes/pluggyWebhookRoutes');
const usageLimiter        = require('./middleware/usageLimiter');
const requestLogger       = require('./middleware/requestLogger');
const errorHandler        = require('./middleware/errorHandler');
const lightCache          = require('./middleware/cache');
const { authenticateToken } = require('./middleware/auth');
const { checkConsentExpiry } = require('./services/openFinanceService');
// [FASE 4] Observabilidade — init defensivo (no-op se SENTRY_DSN ausente)
const { initSentry, captureException, wrapCron, flush: flushSentry, Handlers: SentryHandlers } = require('./lib/sentry');
initSentry();

// ─────────────────────────────────────────────────────────────
// 3. INICIALIZAÇÃO DO APP
// ─────────────────────────────────────────────────────────────
const app = express();

// Trust proxy: obrigatório para Render (Nginx reverso)
// Garante que req.ip retorne o IP real do cliente (rate limiting correto)
app.set('trust proxy', 1);

// [FASE 4] Sentry request handler — DEVE vir antes de qualquer middleware
// para que erros em middlewares posteriores tenham contexto da request.
// No-op gracioso se Sentry não foi inicializado (DSN ausente).
app.use(SentryHandlers.requestHandler({
  // Não capturar dados sensíveis — beforeSend ainda passa por scrubbing
  request: ['method', 'url', 'query_string', 'headers'],
  user:    false,  // não capturar user automaticamente; setamos manualmente
}));

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

// [CRÍTICO-2] Validar comprimento mínimo do JWT_SECRET (< 32 chars é inseguro)
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  console.error('╔══════════════════════════════════════════════════╗');
  console.error('║  ERRO CRÍTICO: JWT_SECRET muito curto (< 32 chars) ║');
  console.error('╚══════════════════════════════════════════════════╝');
  process.exit(1);
}

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

// Webhook Pluggy MUST be mounted before express.json() — uses express.raw internally
app.use('/api/v1', pluggyWebhookRoutes);

app.use(express.json({ limit: '1mb' })); // Limite de payload
app.use(cookieParser()); // [CRÍTICO-1] Habilita req.cookies — necessário para CSRF state do OAuth Google

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
  max: 5,
  message: {
    error: 'Muitas solicitações de insights. Aguarde um momento.',
    code:  'RATE_LIMIT_INSIGHTS',
  },
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.user?.id || req.ip, // por usuário autenticado
});

// [FASE 3.4] Rate limit para desbloqueio de IA via rewarded ad.
// 5 unlocks por janela de 24h por usuário. Cold start do Render pode
// resetar o contador in-memory — aceitável para MVP (sem AdMob SSV ainda).
const adsUnlockLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: {
    error: 'Limite diário de desbloqueios atingido. Volte amanhã.',
    code:  'RATE_LIMIT_AD_UNLOCK',
  },
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `ad_unlock:${req.user?.id || req.ip}`,
});

// [ALTO-2] Rate limit para endpoint público de telemetria
const publicTrackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Muitas requisições. Aguarde.', code: 'RATE_LIMIT_PUBLIC' },
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.ip,
});

// Aplicar rate limit nas rotas de auth
app.use('/api/v1/auth/login',    authLimiter);
app.use('/api/v1/auth/register', authLimiter);
// [ALTO-1] Aplicar insightsLimiter nas rotas de geração de insight e analytics pesados
app.use('/api/v1/insights',           insightsLimiter);
app.use('/api/v1/analytics/emotional', insightsLimiter);
// [ALTO-2] Rate limit no endpoint público de telemetria
app.use('/api/v1/analytics/track-public', publicTrackLimiter);

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

// [FASE 3.2] Schema para tracking de transação não concretizada após aviso.
// NÃO é cancelar uma Transaction — é registrar uma decisão comportamental.
const cancelTransactionSchema = z.object({
  category: z.string().min(1).max(64),
  amount:   z.number().positive(),
  reason:   z.string().max(280).optional(),
});

// [FASE 3.4] Schema para desbloqueio temporário de IA via rewarded ad.
// `source` é só telemetria — qual tela disparou (home/insights/simulation).
const unlockAiSchema = z.object({
  source: z.string().max(64).optional(),
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

v1Router.use('/finance',       financeRoutes);
v1Router.use('/admin',         adminRoutes);
v1Router.use('/growth',        growthRoutes);
v1Router.use('/open-finance',  openFinanceRoutes);

// --- User ---
v1Router.delete('/user/me', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    // [LGPD Art. 18] Logar deleção sem PII do usuário no log público
    console.log(`[LGPD] Solicitação de deleção de conta: ${userId.slice(0, 8)}...`);
    await prisma.user.delete({ where: { id: userId } });
    res.json({ success: true, message: 'Conta excluída permanentemente.' });
  } catch (error) {
    next(error);
  }
});

// [LGPD Art. 18] Portabilidade — exportação dos dados pessoais do usuário
v1Router.get('/user/export', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [user, transactions, goals, insights, notifications] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true, name: true, email: true, monthlyIncome: true,
          createdAt: true, plan: true, streakDays: true, xp: true, level: true,
        },
      }),
      prisma.transaction.findMany({ where: { userId } }),
      prisma.goal.findMany({ where: { userId } }),
      prisma.insight.findMany({ where: { userId } }),
      prisma.notification.findMany({ where: { userId }, take: 100 }),
    ]);

    res.setHeader('Content-Disposition', 'attachment; filename="finmind-meus-dados.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json({
      exportedAt: new Date().toISOString(),
      user,
      transactions,
      goals,
      insights,
      notifications,
    });
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

// [FASE 3.2] POST /transactions/cancel — tracking comportamental.
// Registra a DECISÃO do usuário de NÃO concretizar uma transação após
// receber um aviso. NÃO cria/altera Transaction. Apenas emite um Event
// do tipo 'transaction_cancelled_after_warning' (já consumido em 3 lugares
// por behaviorMetrics.js, alimentando /analytics/timeline).
v1Router.post('/transactions/cancel', authenticateToken, async (req, res, next) => {
  try {
    const payload = {
      ...req.body,
      amount: Number(req.body.amount),
    };
    const result = parseRequest(cancelTransactionSchema, payload);
    if (!result.success) {
      return res.status(400).json({ error: result.errors.join(', ') });
    }
    const { category, amount, reason } = result.data;
    await trackTelemetry(req.user.id, 'transaction_cancelled_after_warning', {
      category,
      amount,
      reason: reason || null,
    });
    res.json({ ok: true });
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
  lightCache(60),     // Cache ANTES do usageLimiter para não incrementar hits cacheados
  usageLimiter('emotional_analytics'),
  async (req, res, next) => {
    try {
      const summary = await getEmotionalAnalyticsSummary(req.user.id);
      res.json(summary);
    } catch (error) {
      next(error);
    }
  }
);

// Alias que o mobile chama como /analytics/summary
v1Router.get('/analytics/summary', authenticateToken, lightCache(60), async (req, res, next) => {
  try {
    const summary = await getEmotionalAnalyticsSummary(req.user.id);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

// /analytics/weekly-summary — retorna o resumo semanal do objeto emotional
v1Router.get('/analytics/weekly-summary', authenticateToken, lightCache(300), async (req, res, next) => {
  try {
    const summary = await getEmotionalAnalyticsSummary(req.user.id);
    res.json(summary?.emotional?.weeklySummary || null);
  } catch (error) {
    next(error);
  }
});

// /analytics/badges — retorna badges do objeto emotional
v1Router.get('/analytics/badges', authenticateToken, lightCache(300), async (req, res, next) => {
  try {
    const summary = await getEmotionalAnalyticsSummary(req.user.id);
    res.json(summary?.emotional?.badges || []);
  } catch (error) {
    next(error);
  }
});

// --- Personal Timeline (chamada pelo mobile em TimelineScreen) ---
// Expõe getPersonalTimeline() — função determinística já existente.
// Retorna array de eventos: { date, type, title, description, impact?, icon? }
v1Router.get('/analytics/timeline', authenticateToken, async (req, res, next) => {
  try {
    // days: 1..365, default 30 — clamp defensivo contra valores fora do range.
    const rawDays = Number(req.query.days);
    const days = Number.isFinite(rawDays)
      ? Math.min(365, Math.max(1, Math.trunc(rawDays)))
      : 30;
    const timeline = await getPersonalTimeline(req.user.id, days);
    // TimelineScreen.js espera array direto em response.data
    res.json(timeline);
  } catch (error) {
    next(error);
  }
});

// [FASE 3.5] Middleware inline: gate de acesso a IA (premium OU unlock ativo).
// Vem ANTES do usageLimiter para não queimar cota de usuários que não têm acesso.
function requireAIAccess(req, res, next) {
  if (!canUseAI(req.user)) {
    return res.status(403).json({
      error: 'IA disponível apenas no Premium ou via desbloqueio temporário.',
      code:  'AI_ACCESS_DENIED',
    });
  }
  next();
}

// [FASE 3.5] GET /insights — últimos 20 insights do usuário, mais recentes primeiro.
// Insights são criados aqui (POST /insights/generate) e pelo dailyAnalysisJob.
v1Router.get('/insights', authenticateToken, async (req, res, next) => {
  try {
    const insights = await prisma.insight.findMany({
      where:   { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take:    20,
      select:  { id: true, type: true, message: true, createdAt: true },
    });
    res.json(insights);
  } catch (error) {
    next(error);
  }
});

// [FASE 3.5] POST /insights/generate — gera 1 novo insight determinístico.
// SEM OpenAI nesta fase. Pipeline:
//   authenticateToken → requireAIAccess → usageLimiter → handler
// Resposta: o registro Insight criado (objeto direto, não envelope).
v1Router.post(
  '/insights/generate',
  authenticateToken,
  requireAIAccess,
  usageLimiter('ai_insight'),
  async (req, res, next) => {
    try {
      const userId = req.user.id;
      // Janela 90d evita carregar histórico completo (performance + LGPD)
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const [user, transactions, goals] = await Promise.all([
        prisma.user.findUnique({
          where:  { id: userId },
          select: { id: true, monthlyIncome: true, streakDays: true, level: true },
        }),
        prisma.transaction.findMany({
          where:  { userId, date: { gte: ninetyDaysAgo } },
          select: { type: true, amount: true, date: true, category: true },
        }),
        prisma.goal.findMany({
          where:  { userId },
          select: { id: true, title: true, targetAmount: true, currentAmount: true, deadline: true },
        }),
      ]);

      if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

      const summary = calculateSummary(user, transactions, goals);
      const { type, message } = generateInsight({
        user,
        summary,
        hasTransactions: transactions.length > 0,
      });

      const insight = await prisma.insight.create({
        data:   { userId, type, message },
        select: { id: true, type: true, message: true, createdAt: true },
      });

      // Mobile espera objeto direto em response.data (não envelope)
      res.json(insight);
    } catch (error) {
      next(error);
    }
  }
);

// [FASE 3.4] POST /ads/unlock-ai — concede 1h de acesso a IA após o usuário
// assistir um rewarded ad. NÃO valida ad token (AdMob SSV) nesta fase —
// "trusted client" assumption. Anti-fraude limitado a rate-limit 5/24h/user.
// TODO Fase 6: integrar AdMob Server-Side Verification (SSV) com nonce.
v1Router.post('/ads/unlock-ai', authenticateToken, adsUnlockLimiter, async (req, res, next) => {
  try {
    const result = parseRequest(unlockAiSchema, req.body || {});
    if (!result.success) {
      return res.status(400).json({ error: result.errors.join(', ') });
    }
    const source = result.data.source || 'unknown';

    // +1h a partir de agora. Substitui qualquer unlock anterior (não estende).
    const aiExpiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: req.user.id },
      data:  { aiUnlockedUntil: aiExpiresAt },
    });

    // [FIX F-1] Invalida o cache do profile para que a próxima chamada
    // a /users/profile reflita imediatamente hasTemporaryAI=true.
    // Sem isso, o lightCache(30) podia servir resposta pré-unlock por até 30s
    // se o usuário fechasse e reabrisse o app logo após assistir o ad.
    lightCache.invalidate(`${req.user.id}:/api/v1/users/profile`);

    await trackTelemetry(req.user.id, 'reward_ad_used', { source });

    return res.json({ ok: true, aiExpiresAt });
  } catch (error) {
    next(error);
  }
});

// --- User Profile (rota faltante chamada pelo mobile) ---
v1Router.get('/users/profile', authenticateToken, lightCache(30), async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, name: true, email: true, avatarUrl: true,
        monthlyIncome: true, streakDays: true, xp: true, level: true,
        isPremium: true, plan: true, onboardingCompleted: true,
        lastCheckIn: true, createdAt: true, provider: true,
        aiUnlockedUntil: true, // [FASE 3.4] usado para derivar campos — não exposto
      },
    });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    // [FASE 3.4] Deriva estado do unlock temporário sem expor o timestamp bruto.
    // Atenção: lightCache(30) acima pode servir resposta defasada por até 30s
    // após o usuário desbloquear — o mobile mitiga com state local imediato.
    const hasTemporaryAI = hasActiveTemporaryAI(user);
    const aiExpiresAt    = hasTemporaryAI ? user.aiUnlockedUntil : null;
    const { aiUnlockedUntil, ...publicUser } = user;

    res.json({ ...publicUser, hasTemporaryAI, aiExpiresAt });
  } catch (error) {
    next(error);
  }
});

// --- Check-in diário (rota faltante chamada pelo mobile) ---
v1Router.post('/checkin', authenticateToken, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (user.lastCheckIn) {
      const lastDay = new Date(user.lastCheckIn);
      lastDay.setHours(0, 0, 0, 0);
      if (lastDay.getTime() === today.getTime()) {
        return res.status(400).json({ error: 'Você já fez check-in hoje.' });
      }
    }

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const isConsecutive = user.lastCheckIn && new Date(user.lastCheckIn) >= yesterday;
    const newStreak = isConsecutive ? user.streakDays + 1 : 1;

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { lastCheckIn: new Date(), streakDays: newStreak },
      select: { streakDays: true },
    });

    res.json({ success: true, streakDays: updated.streakDays });
  } catch (error) {
    next(error);
  }
});

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
v1Router.post('/jobs/run-daily', authenticateToken, async (req, res, next) => {
  // [ALTO-3] Timing-safe comparison + autenticação dupla (JWT + admin token)
  const adminToken    = process.env.ADMIN_TOKEN || '';
  const providedToken = req.header('x-admin-token') || '';
  if (adminToken.length === 0 || providedToken.length === 0) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  const tokenA = Buffer.from(adminToken.padEnd(64));
  const tokenB = Buffer.from(providedToken.padEnd(64));
  if (tokenA.length !== tokenB.length || !crypto.timingSafeEqual(tokenA, tokenB) || providedToken !== adminToken) {
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
// [FASE 4] Sentry error handler — vem ANTES do errorHandler custom.
// Captura o erro e chama next(err) — não responde nem altera o fluxo.
// Já é seletivo: por padrão captura status >= 500.
app.use(SentryHandlers.errorHandler({
  shouldHandleError(error) {
    const status = error.status || error.statusCode;
    // Não capturar 4xx (auth, validation) — fluxo normal
    return !status || status >= 500;
  },
}));
app.use(errorHandler);

// ─────────────────────────────────────────────────────────────
// 15. PROCESS ERROR HANDLERS
// ─────────────────────────────────────────────────────────────
process.on('uncaughtException', async (err) => {
  console.error('❌ [CRITICAL] Uncaught Exception:', err);
  captureException(err, { tags: { handler: 'uncaughtException' } });
  await flushSentry(2000);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('❌ [CRITICAL] Unhandled Rejection:', reason);
  const err = reason instanceof Error ? reason : new Error(String(reason));
  captureException(err, { tags: { handler: 'unhandledRejection' } });
  await flushSentry(2000);
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
          captureException(err, { tags: { cron: 'growth_engine' } });
        }
      });

      setTimeout(() => {
        runGrowthEngine().catch(console.error);
      }, 60_000);

      // Open Finance: verificar consentimentos expirados diariamente às 2h
      cron.schedule('0 2 * * *', async () => {
        try {
          const count = await checkConsentExpiry();
          if (count > 0) console.log(`[OpenFinance] ${count} consentimentos marcados como expirados.`);
        } catch (err) {
          console.error('[OpenFinance] Erro no job de expiração:', err.message);
          captureException(err, { tags: { cron: 'open_finance_consent_expiry' } });
        }
      });

      // [LGPD Art. 15] Retenção de dados: limpar Events, AuthCodes e Sessions expiradas semanalmente.
      // [FASE 6] Session cleanup: remove tanto expiradas naturalmente quanto revogadas
      // (revogadas mantemos por curto prazo apenas para auditoria — 7d após revogação).
      cron.schedule('0 3 * * 0', async () => {
        try {
          const now = new Date();
          const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          const sevenDaysAgo  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
          const [deletedEvents, deletedCodes, deletedSessions] = await Promise.all([
            prisma.event.deleteMany({ where: { createdAt: { lt: ninetyDaysAgo } } }),
            prisma.authCode.deleteMany({ where: { expiresAt: { lt: now } } }),
            prisma.session.deleteMany({
              where: {
                OR: [
                  { expiresAt: { lt: now } },                  // expiradas naturalmente
                  { revokedAt: { lt: sevenDaysAgo } },         // revogadas há mais de 7d
                ],
              },
            }),
          ]);
          console.log(`[LGPD Retention] Removidos: ${deletedEvents.count} events, ${deletedCodes.count} auth codes, ${deletedSessions.count} sessions.`);
        } catch (err) {
          console.error('[LGPD Retention] Erro na limpeza:', err.message);
          captureException(err, { tags: { cron: 'lgpd_retention' } });
        }
      });
    });
  } catch (error) {
    console.error('❌ ERRO CRÍTICO NO STARTUP:', error.message);
    if (error.code) console.error('Código Prisma:', error.code);
    console.error(error.stack);
    process.exit(1);
  }
}

startServer();
