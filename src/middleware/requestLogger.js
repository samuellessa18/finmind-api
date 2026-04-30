const crypto = require('crypto');

/**
 * Middleware de logs estruturados para observabilidade em produção
 */
const requestLogger = (req, res, next) => {
  req.id = crypto.randomUUID(); // Identificador único por request nativo do Node.js 16.7+
  const startTime = Date.now();

  // Log na entrada (opcional, bom para debug de requests lentos)
  // console.log(`[REQ][${req.id}] ${req.method} ${req.path}`);

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const userId = req.user ? req.user.id : 'anonymous';
    
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      userId,
      ip: req.ip,
      userAgent: req.get('user-agent')
    }));
  });

  next();
};

module.exports = requestLogger;
