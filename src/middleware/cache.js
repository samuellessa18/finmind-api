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

// [FIX F-1] Invalidação pontual de uma chave do cache.
// Usar quando o estado do usuário muda fora do fluxo normal de GET
// (ex: após /ads/unlock-ai invalidar o cache de /users/profile).
// Operação O(1) no Map. Idempotente — Map.delete não lança se a
// chave não existir e retorna apenas boolean.
// Formato da chave: `${userId}:${originalUrl}`
//
// NOTA sobre race condition residual:
//   Se uma requisição GET estiver in-flight (handler já passou pelo
//   cache.get e fará cache.set ao retornar) NO MOMENTO em que
//   invalidate() é chamado, ela pode reescrever a cache com dados
//   "pré-mutação" após o delete. Janela típica: ~10-50ms.
//   Tradeoff aceito: o bug original (TTL 30s garantido) é reduzido
//   para uma race rara de dezenas de ms. Solução completa exigiria
//   versioning do cache — fora de escopo (refactor amplo).
lightCache.invalidate = (key) => cache.delete(key);

module.exports = lightCache;
