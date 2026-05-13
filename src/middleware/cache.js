'use strict';

// [MÉDIO-1] Cache leve em memória com eviction periódica.
// Sem eviction, o Map cresce indefinidamente em produção (memory leak).

const cache = new Map();

// Eviction a cada 5 min — remove entradas expiradas para liberar memória
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of cache.entries()) {
    if (now >= entry.expiresAt) {
      cache.delete(key);
      evicted++;
    }
  }
  if (evicted > 0) {
    console.log(`[CACHE] Evicted ${evicted} expired entries. Size: ${cache.size}`);
  }
}, EVICTION_INTERVAL_MS).unref(); // .unref() não impede o processo de sair

const lightCache = (ttl = 60) => {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();

    const key = `${req.user?.id || 'public'}:${req.originalUrl}`;
    const cached = cache.get(key);

    if (cached && Date.now() < cached.expiresAt) {
      return res.json(cached.data);
    }

    const originalJson = res.json.bind(res);
    res.json = function (data) {
      if (res.statusCode === 200) {
        cache.set(key, { data, expiresAt: Date.now() + ttl * 1000 });
      }
      return originalJson(data);
    };

    next();
  };
};

module.exports = lightCache;
