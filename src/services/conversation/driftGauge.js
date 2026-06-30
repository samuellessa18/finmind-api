'use strict';

// [Consultor · 1D] Gauge de drift (observabilidade, D1D-8/D1D-10). SELECT PRÓPRIO read-only, ancorado
// no now() do Postgres, espelhando COALESCE(providerCallStartedAt,updatedAt) de _findStaleForUser
// (E2 congelado). NÃO altera metrics.js / cron / E2. Alimenta o contador drift_nonzero.
// drift = C - (B + A + D + S); pós-reconciliação saudável → 0 (S=0).
//
// Fonte dos usuários: SELECT independente (R-D3-CRON-NO-USERIDS) — não depende do retorno do cron.

const chatConfig = require('../../config/chatConfig'); // read-only (thresholds únicos)
const TTL = chatConfig.turn.ttlStaleAdmittedSeconds;
const LLM_SEC = Math.ceil(chatConfig.turn.llmTimeoutMs / 1000);

async function computeDriftSnapshot(prisma, { batchSize = 500 } = {}) {
  const rows = await prisma.$queryRaw`
    SELECT a."userId", a."dayKey",
      COALESCE((SELECT count FROM "ChatUsage" u WHERE u."userId"=a."userId" AND u."dayKey"=a."dayKey"),0)::int AS c,
      (SELECT count(*) FROM "ChatTurn" t WHERE t."userId"=a."userId" AND t."dayKey"=a."dayKey" AND t.state='BILLED')::int AS b,
      (SELECT count(*) FROM "ChatTurn" t WHERE t."userId"=a."userId" AND t."dayKey"=a."dayKey"
         AND t.state='ADMITTED' AND t."updatedAt" >= now() - make_interval(secs => ${TTL}))::int AS a_in,
      (SELECT count(*) FROM "ChatTurn" t WHERE t."userId"=a."userId" AND t."dayKey"=a."dayKey"
         AND t.state='DISPATCHING' AND COALESCE(t."providerCallStartedAt",t."updatedAt") >= now() - make_interval(secs => ${LLM_SEC}))::int AS d,
      (SELECT count(*) FROM "ChatTurn" t WHERE t."userId"=a."userId" AND t."dayKey"=a."dayKey"
         AND ((t.state='ADMITTED'    AND t."updatedAt" < now() - make_interval(secs => ${TTL}))
           OR (t.state='DISPATCHING' AND COALESCE(t."providerCallStartedAt",t."updatedAt") < now() - make_interval(secs => ${LLM_SEC}))))::int AS s
    FROM (
      SELECT DISTINCT "userId","dayKey" FROM "ChatUsage" WHERE count > 0
      UNION
      SELECT DISTINCT "userId","dayKey" FROM "ChatTurn" WHERE state IN ('ADMITTED','DISPATCHING')
    ) a
    LIMIT ${batchSize}`;
  return rows.map((r) => ({
    userId: r.userId, dayKey: r.dayKey,
    c: r.c, b: r.b, a: r.a_in, d: r.d, s: r.s,
    drift: r.c - (r.b + r.a_in + r.d + r.s),
  }));
}

function isDriftNonZero(rows) {
  return (rows || []).some((r) => r.drift !== 0);
}

module.exports = { computeDriftSnapshot, isDriftNonZero };
