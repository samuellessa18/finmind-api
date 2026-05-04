const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const { z } = require('zod');
const prisma = require('../../prisma/client');
const { trackTelemetry } = require('../services/telemetryService');
const { verifyGoogleToken, findOrCreateGoogleUser } = require('../services/googleAuth');

const router = express.Router();

// Schemas
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

const parseRequest = (schema, data) => {
  try {
    return { success: true, data: schema.parse(data) };
  } catch (error) {
    return { success: false, errors: error.errors.map((err) => err.message) };
  }
};

// Routes

/**
 * POST /api/v1/auth/register
 */
router.post('/auth/register', async (req, res, next) => {
  console.log("🔥 /auth/register chamada");
  try {
    const payload = {
      ...req.body,
      monthlyIncome: Number(req.body.monthlyIncome || 0)
    };
    await trackTelemetry(null, 'auth_started', { provider: 'local', type: 'register' });
    const result = parseRequest(registerSchema, payload);
    if (!result.success) {
      await trackTelemetry(null, 'auth_failed', { provider: 'local', type: 'register', reason: 'validation_error' });
      return res.status(400).json({ error: result.errors.join(', ') });
    }

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
    const secret = process.env.JWT_SECRET;
    const token = jwt.sign({ id: user.id, environmentId: user.environmentId }, secret, { expiresIn: '1d' });
    
    await trackTelemetry(user.id, 'account_created', { email: user.email });
    await trackTelemetry(user.id, 'auth_success', { provider: 'local', type: 'register' });

    const { password, ...safeUser } = user;
    res.json({ user: safeUser, token });
  } catch (error) {
    await trackTelemetry(null, 'auth_failed', { provider: 'local', type: 'register', reason: 'server_error' });
    next(error);
  }
});

/**
 * POST /api/v1/auth/login
 */
router.post('/auth/login', async (req, res, next) => {
  console.log("🔥 /auth/login chamada");
  try {
    const payload = { ...req.body };
    await trackTelemetry(null, 'auth_started', { provider: 'local', type: 'login' });
    const result = parseRequest(loginSchema, payload);
    if (!result.success) {
      await trackTelemetry(null, 'auth_failed', { provider: 'local', type: 'login', reason: 'validation_error' });
      return res.status(400).json({ error: result.errors.join(', ') });
    }

    const user = await prisma.user.findUnique({ where: { email: result.data.email } });
    if (!user || !(await bcrypt.compare(result.data.password, user.password))) {
      await trackTelemetry(null, 'auth_failed', { provider: 'local', type: 'login', reason: 'invalid_credentials' });
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    
    const secret = process.env.JWT_SECRET;
    const token = jwt.sign({ id: user.id, environmentId: user.environmentId }, secret, { expiresIn: '1d' });
    
    await trackTelemetry(user.id, 'user_login', { method: 'password' });
    await trackTelemetry(user.id, 'auth_success', { provider: 'local', type: 'login' });

    const { password, ...safeUser } = user;
    res.json({ user: safeUser, token });
  } catch (error) {
    await trackTelemetry(null, 'auth_failed', { provider: 'local', type: 'login', reason: 'server_error' });
    next(error);
  }
});

/**
 * GET /api/v1/auth/google
 */
router.get('/auth/google', async (req, res) => {
  console.log("🔥 /auth/google chamada");
  // Teste simplificado solicitado pelo usuário
  res.send('Google route funcionando');
  
  /* Logica real comentada para teste de rota
  await trackTelemetry(null, 'auth_started', { provider: 'google', type: 'oauth' });
  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/v1/auth/google/callback',
    client_id: process.env.GOOGLE_CLIENT_ID_WEB,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
  };

  const qs = new URLSearchParams(options);
  res.redirect(`${rootUrl}?${qs.toString()}`);
  */
});

/**
 * GET /api/v1/auth/google/callback
 */
router.get('/auth/google/callback', async (req, res, next) => {
  console.log("🔥 /auth/google/callback chamada");
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'Código de autorização não fornecido' });

  try {
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID_WEB,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/v1/auth/google/callback',
      grant_type: 'authorization_code',
    });

    const { id_token } = data;
    const googleData = await verifyGoogleToken(id_token);
    const user = await findOrCreateGoogleUser(googleData);

    const tempCode = crypto.randomBytes(32).toString('hex');
    await prisma.authCode.create({
      data: {
        code: tempCode,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60000)
      }
    });

    await trackTelemetry(user.id, user.provider === 'google' ? 'google_signup_success' : 'google_login_success');

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/auth/callback?code=${tempCode}`);
  } catch (error) {
    console.error('[GOOGLE_CALLBACK] Erro:', error.response?.data || error.message);
    await trackTelemetry(null, 'auth_failed', { provider: 'google', type: 'oauth', reason: 'callback_error' });
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=auth_failed`);
  }
});

/**
 * POST /api/v1/auth/google/exchange
 */
router.post('/auth/google/exchange', async (req, res, next) => {
  console.log("🔥 /auth/google/exchange chamada");
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código requerido' });

  try {
    const authRecord = await prisma.authCode.findUnique({
      where: { code }
    });

    if (!authRecord || authRecord.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Código inválido ou expirado' });
    }

    const user = await prisma.user.findUnique({ where: { id: authRecord.userId } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    await prisma.authCode.delete({ where: { id: authRecord.id } });

    const secret = process.env.JWT_SECRET;
    const token = jwt.sign({ id: user.id, environmentId: user.environmentId }, secret, { expiresIn: '1d' });

    const { password, ...safeUser } = user;
    await trackTelemetry(user.id, 'auth_success', { provider: user.provider, type: 'oauth_exchange' });
    res.json({ user: safeUser, token });
  } catch (error) {
    await trackTelemetry(null, 'auth_failed', { provider: 'google', type: 'oauth_exchange', reason: 'invalid_code' });
    next(error);
  }
});

/**
 * POST /api/v1/auth/google/mobile
 */
router.post('/auth/google/mobile', async (req, res, next) => {
  console.log("🔥 /auth/google/mobile chamada");
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken requerido' });

  try {
    const googleData = await verifyGoogleToken(idToken);
    const user = await findOrCreateGoogleUser(googleData);

    const secret = process.env.JWT_SECRET;
    const token = jwt.sign({ id: user.id, environmentId: user.environmentId }, secret, { expiresIn: '1d' });

    await trackTelemetry(user.id, 'google_login_success', { platform: 'mobile' });

    const { password, ...safeUser } = user;
    await trackTelemetry(user.id, 'auth_success', { provider: user.provider, type: 'mobile_oauth' });
    res.json({ user: safeUser, token });
  } catch (error) {
    await trackTelemetry(null, 'auth_failed', { provider: 'google', type: 'mobile_oauth', reason: 'token_error' });
    next(error);
  }
});

module.exports = router;
