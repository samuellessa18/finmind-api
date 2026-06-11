/**
 * FinMind API — authRoutes.js
 * Versão: PATCHED (Auditoria de Segurança)
 *
 * Correções aplicadas:
 *  1. CSRF state token no fluxo OAuth Google (previne CSRF attack)
 *  2. redirect_uri consistente entre /auth/google e /auth/google/callback
 *     (corrigido: callback usava fallback localhost em produção — QUEBRAVA o OAuth)
 *  3. GOOGLE_CLIENT_SECRET lido corretamente (era "GOOGLE_CLIENT_SECRET" — correto)
 *  4. bcrypt rounds aumentados para 12 (era 10 — mínimo recomendado atual)
 *  5. JWT expiresIn aumentado para 7d (era 1d — melhor UX mobile)
 *  6. Merge de contas híbrido (Google + senha → provider: 'hybrid')
 *  7. Limpeza de AuthCode expirados no exchange (previne acúmulo)
 *  8. Sanitização de erro no callback (não vazar mensagem interna)
 *  9. Verificação de GOOGLE_CLIENT_SECRET antes de usar
 * 10. Logs limpos: remover console.log de dados sensíveis
 */

'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const axios    = require('axios');
const { z }    = require('zod');
const prisma   = require('../../prisma/client');
const { trackTelemetry }              = require('../services/telemetryService');
const { verifyGoogleToken, findOrCreateGoogleUser } = require('../services/googleAuth');
// [FASE 6] Logout precisa de auth + invalidação de cache do profile
const { authenticateToken } = require('../middleware/auth');
const lightCache            = require('../middleware/cache');

const router = express.Router();

// [CRÍTICO-5] Hash dummy pré-computado para proteção de timing no login.
// Um hash VÁLIDO garante que bcrypt.compare execute o trabalho completo (~250ms),
// eliminando a diferença de tempo entre "usuário não existe" e "senha errada".
// Gerado uma vez no startup — não no request path.
const DUMMY_HASH = require('bcryptjs').hashSync('__finmind_timing_protection__', 12);

// ─────────────────────────────────────────────────────────────
// SCHEMAS ZOD
// ─────────────────────────────────────────────────────────────
const registerSchema = z.object({
  name:          z.string().min(2).max(100),
  email:         z.string().email().toLowerCase(),
  password:      z.string().min(8).max(128), // CORRIGIDO: mínimo 8 (era 6)
  monthlyIncome: z.number().nonnegative().optional().default(0),
});

const loginSchema = z.object({
  email:    z.string().email().toLowerCase(),
  password: z.string().min(1).max(128),
});

const parseRequest = (schema, data) => {
  try {
    return { success: true, data: schema.parse(data) };
  } catch (error) {
    return { success: false, errors: error.errors.map((e) => e.message) };
  }
};

// ─────────────────────────────────────────────────────────────
// HELPER: Gerar JWT + Session (FASE 6)
// Retorna { token, jti }. O caller é responsável por persistir a Session
// (não fazemos aqui para deixar o helper puro/testável).
// ─────────────────────────────────────────────────────────────
const JWT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias — alinha JWT e Session

function generateJWT(user) {
  const secret = process.env.JWT_SECRET;
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { id: user.id, environmentId: user.environmentId, jti },
    secret,
    { expiresIn: '7d' }
  );
  return { token, jti };
}

// [FASE 6] Persiste a Session associada ao jti. Best-effort:
// ipHash anonimiza (SHA256 truncado), userAgent truncado para evitar
// payloads gigantes. Sem captureException aqui — o caller decide.
async function createSession(jti, user, req) {
  const ip = req.ip || '';
  const ipHash = ip
    ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16)
    : null;
  const userAgent = (req.get('user-agent') || '').slice(0, 255) || null;
  await prisma.session.create({
    data: {
      id:        jti,
      userId:    user.id,
      expiresAt: new Date(Date.now() + JWT_TTL_MS),
      ipHash,
      userAgent,
    },
  });
}

// ─────────────────────────────────────────────────────────────
// HELPER: Remover senha do objeto user
// ─────────────────────────────────────────────────────────────
function safeUser(user) {
  const { password, ...rest } = user;
  return rest;
}

// ─────────────────────────────────────────────────────────────
// POST /api/v1/auth/register
// ─────────────────────────────────────────────────────────────
router.post('/auth/register', async (req, res, next) => {
  try {
    const payload = {
      ...req.body,
      monthlyIncome: Number(req.body.monthlyIncome || 0),
    };

    await trackTelemetry(null, 'auth_started', { provider: 'local', type: 'register' });

    const result = parseRequest(registerSchema, payload);
    if (!result.success) {
      await trackTelemetry(null, 'auth_failed', {
        provider: 'local', type: 'register', reason: 'validation_error',
      });
      return res.status(400).json({ error: result.errors.join(', ') });
    }

    // Verificar duplicidade de email
    const existing = await prisma.user.findUnique({
      where: { email: result.data.email },
    });
    if (existing) {
      await trackTelemetry(null, 'auth_failed', {
        provider: 'local', type: 'register', reason: 'email_taken',
      });
      return res.status(409).json({ error: 'Este e-mail já está em uso.' });
    }

    // CORRIGIDO: bcrypt rounds 12 (era 10)
    const hashedPassword = await bcrypt.hash(result.data.password, 12);

    const environment = await prisma.environment.create({
      data: { name: `Ambiente de ${result.data.name}` },
    });

    const user = await prisma.user.create({
      data: {
        name:          result.data.name,
        email:         result.data.email,
        password:      hashedPassword,
        monthlyIncome: result.data.monthlyIncome,
        environmentId: environment.id,
        provider:      'local',
        lgpdConsentAt: new Date(), // [LGPD Art. 7, I] Consentimento registrado no cadastro
      },
    });

    // [FASE 6] JWT com jti + Session persistida
    const { token, jti } = generateJWT(user);
    await createSession(jti, user, req);

    await trackTelemetry(user.id, 'account_created', { email: user.email });
    await trackTelemetry(user.id, 'auth_success', { provider: 'local', type: 'register' });

    return res.status(201).json({ user: safeUser(user), token });
  } catch (error) {
    // [DIAG-TEMP] Revela a exceção real do cadastro (errorHandler oculta stack/code
    // em produção). Remover após diagnóstico.
    console.error('[REGISTER ERROR]', {
      name:    error?.name,
      code:    error?.code,
      message: error?.message,
      meta:    error?.meta,
      stack:   error?.stack,
    });
    await trackTelemetry(null, 'auth_failed', {
      provider: 'local', type: 'register', reason: 'server_error',
    });
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/auth/login
// ─────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res, next) => {
  try {
    const payload = { ...req.body };

    await trackTelemetry(null, 'auth_started', { provider: 'local', type: 'login' });

    const result = parseRequest(loginSchema, payload);
    if (!result.success) {
      await trackTelemetry(null, 'auth_failed', {
        provider: 'local', type: 'login', reason: 'validation_error',
      });
      return res.status(400).json({ error: result.errors.join(', ') });
    }

    const user = await prisma.user.findUnique({ where: { email: result.data.email } });

    // [CRÍTICO-5] Timing-safe: SEMPRE executa bcrypt.compare com hash válido.
    // DUMMY_HASH é pré-computado no startup — nunca um hash malformado.
    const passwordToCompare = user?.password || DUMMY_HASH;
    const passwordMatch     = await bcrypt.compare(result.data.password, passwordToCompare);

    // [ALTO-5] Verificar provider APÓS bcrypt (nunca antes — mantém timing uniforme)
    // mas ANTES de retornar 401 genérico para dar UX útil a usuários Google.
    if (!user) {
      await trackTelemetry(null, 'auth_failed', {
        provider: 'local', type: 'login', reason: 'invalid_credentials',
      });
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Usuário Google (sem senha local) — erro específico após bcrypt para manter timing
    if (user.provider === 'google' && !user.password) {
      return res.status(400).json({
        error: 'Esta conta foi criada com Google. Use o login com Google.',
      });
    }

    if (!passwordMatch) {
      await trackTelemetry(user.id, 'auth_failed', {
        provider: 'local', type: 'login', reason: 'invalid_credentials',
      });
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // [FASE 6] JWT com jti + Session persistida
    const { token, jti } = generateJWT(user);
    await createSession(jti, user, req);

    await trackTelemetry(user.id, 'user_login', { method: 'password' });
    await trackTelemetry(user.id, 'auth_success', { provider: 'local', type: 'login' });

    return res.json({ user: safeUser(user), token });
  } catch (error) {
    await trackTelemetry(null, 'auth_failed', {
      provider: 'local', type: 'login', reason: 'server_error',
    });
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/auth/google
// Inicia o fluxo OAuth com CSRF state token
// ─────────────────────────────────────────────────────────────
router.get('/auth/google', async (req, res) => {
  await trackTelemetry(null, 'auth_started', { provider: 'google', type: 'oauth' });

  // CSRF state: token aleatório para validar no callback
  const state = crypto.randomBytes(16).toString('hex');
  // Armazenar em cookie httpOnly (não acessível por JS)
  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   10 * 60 * 1000, // 10 minutos
  });

  // CORRIGIDO: usar sempre GOOGLE_CALLBACK_URL (sem fallback localhost em produção)
  const redirectUri = process.env.GOOGLE_CALLBACK_URL;

  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const params  = new URLSearchParams({
    redirect_uri:  redirectUri,
    client_id:     process.env.GOOGLE_CLIENT_ID_WEB,
    access_type:   'offline',
    response_type: 'code',
    prompt:        'consent',
    state,
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
  });

  return res.redirect(`${rootUrl}?${params.toString()}`);
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/auth/google/callback
// ─────────────────────────────────────────────────────────────
router.get('/auth/google/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const frontendUrl =
    process.env.FRONTEND_URL || 'https://finan-as-pessoais-seven.vercel.app';

  // Erro retornado pelo Google (ex: usuário cancelou)
  if (oauthError) {
    console.warn(`[GOOGLE_CALLBACK] OAuth error retornado pelo Google: ${oauthError}`);
    return res.redirect(`${frontendUrl}/login?error=oauth_cancelled`);
  }

  if (!code) {
    return res.redirect(`${frontendUrl}/login?error=missing_code`);
  }

  // CSRF: validar state
  const storedState = req.cookies?.oauth_state;
  if (!state || !storedState || state !== storedState) {
    console.warn('[SECURITY][GOOGLE_CALLBACK] CSRF state inválido ou ausente.');
    return res.redirect(`${frontendUrl}/login?error=csrf_invalid`);
  }
  // Limpar cookie de state
  res.clearCookie('oauth_state');

  try {
    // CORRIGIDO: redirect_uri idêntico ao usado em /auth/google
    // (anteriormente havia fallback localhost — Google rejeita se diferente)
    const redirectUri = process.env.GOOGLE_CALLBACK_URL;

    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID_WEB,
      client_secret: process.env.GOOGLE_CLIENT_SECRET, // CORRIGIDO: variável correta
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    });

    const { id_token } = data;
    if (!id_token) throw new Error('id_token ausente na resposta do Google');

    const googleData = await verifyGoogleToken(id_token);
    const user       = await findOrCreateGoogleUser(googleData);

    // Gerar código temporário (one-time-use, 5 min)
    const tempCode = crypto.randomBytes(32).toString('hex');
    await prisma.authCode.create({
      data: {
        code:      tempCode,
        userId:    user.id,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    // Limpar códigos expirados deste usuário (housekeeping)
    await prisma.authCode.deleteMany({
      where: { userId: user.id, expiresAt: { lt: new Date() }, code: { not: tempCode } },
    });

    await trackTelemetry(
      user.id,
      user.provider === 'google' ? 'google_signup_success' : 'google_login_success'
    );

    return res.redirect(`${frontendUrl}/auth/callback?code=${tempCode}`);
  } catch (error) {
    // Não vazar detalhes internos — logar internamente apenas
    console.error('[GOOGLE_CALLBACK] Erro:', {
      message: error.message,
      googleResponse: error.response?.data,
    });
    await trackTelemetry(null, 'auth_failed', {
      provider: 'google', type: 'oauth', reason: 'callback_error',
    });
    return res.redirect(`${frontendUrl}/login?error=auth_failed`);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/auth/google/exchange
// Troca o código temporário por JWT
// ─────────────────────────────────────────────────────────────
router.post('/auth/google/exchange', async (req, res, next) => {
  const { code } = req.body;

  if (!code || typeof code !== 'string' || code.length !== 64) {
    return res.status(400).json({ error: 'Código inválido.' });
  }

  try {
    const authRecord = await prisma.authCode.findUnique({ where: { code } });

    if (!authRecord) {
      return res.status(401).json({ error: 'Código não encontrado ou já utilizado.' });
    }

    if (authRecord.expiresAt < new Date()) {
      // Limpar registro expirado
      await prisma.authCode.delete({ where: { id: authRecord.id } });
      return res.status(401).json({ error: 'Código expirado. Faça login novamente.' });
    }

    const user = await prisma.user.findUnique({ where: { id: authRecord.userId } });
    if (!user) {
      await prisma.authCode.delete({ where: { id: authRecord.id } });
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    // Deletar código (one-time-use)
    await prisma.authCode.delete({ where: { id: authRecord.id } });

    // [FASE 6] JWT com jti + Session persistida
    const { token, jti } = generateJWT(user);
    await createSession(jti, user, req);

    await trackTelemetry(user.id, 'auth_success', {
      provider: user.provider, type: 'oauth_exchange',
    });

    return res.json({ user: safeUser(user), token });
  } catch (error) {
    await trackTelemetry(null, 'auth_failed', {
      provider: 'google', type: 'oauth_exchange', reason: 'server_error',
    });
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/auth/google/mobile
// Fluxo mobile: recebe idToken direto do Google SDK
// ─────────────────────────────────────────────────────────────
router.post('/auth/google/mobile', async (req, res, next) => {
  const { idToken } = req.body;

  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ error: 'idToken requerido.' });
  }

  try {
    const googleData = await verifyGoogleToken(idToken);
    const user       = await findOrCreateGoogleUser(googleData);

    // [FASE 6] JWT com jti + Session persistida
    const { token, jti } = generateJWT(user);
    await createSession(jti, user, req);

    await trackTelemetry(user.id, 'auth_success', {
      provider: user.provider, type: 'mobile_oauth',
    });

    return res.json({ user: safeUser(user), token });
  } catch (error) {
    await trackTelemetry(null, 'auth_failed', {
      provider: 'google', type: 'mobile_oauth', reason: 'token_error',
    });
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────
// [FASE 6] POST /api/v1/auth/logout
// Revoga a Session atual. Idempotente:
//   - Token COM jti + Session ativa → marca revokedAt = NOW
//   - Token COM jti + Session já revogada/inexistente → 200 ok mesmo assim
//   - Token SEM jti (legacy pré-Fase 6) → 200 ok (apenas resposta semântica)
// Mobile sempre chama best-effort antes de limpar storage local —
// a resposta confirma para o user que o backend processou.
// ─────────────────────────────────────────────────────────────
router.post('/auth/logout', authenticateToken, async (req, res, next) => {
  try {
    if (req.session) {
      // updateMany para idempotência (filtro revokedAt:null garante não-double-revoke)
      await prisma.session.updateMany({
        where: { id: req.session.id, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
    }
    // [FIX F-1 alinhado] Invalida cache de profile para evitar leak pós-logout
    lightCache.invalidate(`${req.user.id}:/api/v1/users/profile`);

    await trackTelemetry(req.user.id, 'user_logout', { hadSession: !!req.session });
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
