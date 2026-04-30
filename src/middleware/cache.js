const cache = new Map();

/**
 * Cache leve em memória para reduzir carga no banco e OpenAI
 * @param {number} ttl - Time to live em segundos
 */
const lightCache = (ttl = 60) => {
  return (req, res, next) => {
    // Apenas cachear GET requests
    if (req.method !== 'GET') return next();

    const key = `${req.user?.id || 'public'}:${req.originalUrl}`;
    const cachedResponse = cache.get(key);

    if (cachedResponse && Date.now() < cachedResponse.expiresAt) {
      // console.log(`[CACHE] Hit para ${key}`);
      return res.json(cachedResponse.data);
    }

    // Sobrescreve res.json para capturar os dados e salvar no cache
    const originalJson = res.json;
    res.json = function (data) {
      if (res.statusCode === 200) {
        cache.set(key, {
          data,
          expiresAt: Date.now() + ttl * 1000
        });
      }
      return originalJson.call(this, data);
    };

    next();
  };
};

module.exports = lightCache;
