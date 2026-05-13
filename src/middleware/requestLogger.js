'use strict';

// [MÉDIO-2] LGPD: IP é dado pessoal (Art. 5, I).
// Anonimizar antes de logar: IPv4 → zerar último octeto, IPv6 → zerar últimos 80 bits.

const crypto = require('crypto');

function anonymizeIP(ip) {
  if (!ip) return 'unknown';
  // IPv4: x.x.x.0
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return ip.replace(/\.\d+$/, '.0');
  }
  // IPv4-mapped IPv6: ::ffff:x.x.x.x
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+)\.\d+$/i);
  if (v4mapped) return `::ffff:${v4mapped[1]}.0`;
  // IPv6: manter apenas primeiros 48 bits (3 grupos)
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + '::/48';
  }
  return 'unknown';
}

const requestLogger = (req, res, next) => {
  req.id = crypto.randomUUID();
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const userId   = req.user ? req.user.id : 'anonymous';

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId: req.id,
      method:    req.method,
      path:      req.path,
      status:    res.statusCode,
      duration:  `${duration}ms`,
      userId,
      ip:        anonymizeIP(req.ip), // [MÉDIO-2] IP anonimizado
      userAgent: req.get('user-agent'),
    }));
  });

  next();
};

module.exports = requestLogger;
