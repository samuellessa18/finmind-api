'use strict';

const rateLimit = require('express-rate-limit');

// 5 new bank connections per user per hour
const connectLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `of_connect:${req.user?.id ?? req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de conexão. Aguarde 1 hora.' },
});

// 1 manual sync per connection per 5 minutes
const syncLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 1,
  keyGenerator: (req) => `of_sync:${req.user?.id ?? req.ip}:${req.params?.id ?? ''}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Sincronização já executada recentemente. Aguarde 5 minutos.' },
});

module.exports = { connectLimiter, syncLimiter };
