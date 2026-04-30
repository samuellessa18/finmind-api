/**
 * Middleware global de tratamento de erros para padronização SaaS
 */
const errorHandler = (err, req, res, next) => {
  const statusCode = err.status || 500;
  const message = err.message || 'Ocorreu um erro interno no servidor';
  const code = err.code || 'INTERNAL_SERVER_ERROR';

  console.error(`[ERROR][${req.method}] ${req.path} - ${message}`);
  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack);
  }

  res.status(statusCode).json({
    success: false,
    message,
    code,
    requestId: req.id // Gerado pelo logger se disponível
  });
};

module.exports = errorHandler;
