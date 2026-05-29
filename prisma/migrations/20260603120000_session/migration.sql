-- FinMind — Migration: add Session model (FASE 6 — JWT Revocation)
-- Apply with:    npx prisma migrate deploy
-- Reversibility: DROP TABLE IF EXISTS "Session";
--
-- Safety:
--   * Tabela nova (zero impacto em dados existentes)
--   * IF NOT EXISTS na CREATE TABLE e nos índices
--   * FK com ON DELETE CASCADE (sessão segue ciclo de vida do user)
--   * Sem alteração em tabelas existentes (User intacto — relação @relation
--     do Prisma resolve via FK definida aqui)
--
-- Propósito: id = jti do JWT (UUID). Permite revogação stateful via update
-- de revokedAt. Tokens legados (sem jti) operam em "grace period" no
-- middleware até expirarem naturalmente.

CREATE TABLE IF NOT EXISTS "Session" (
  "id"        TEXT         NOT NULL,
  "userId"    TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "ipHash"    TEXT,
  "userAgent" TEXT,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Session_userId_idx"             ON "Session"("userId");
CREATE INDEX IF NOT EXISTS "Session_expiresAt_idx"          ON "Session"("expiresAt");
CREATE INDEX IF NOT EXISTS "Session_userId_revokedAt_idx"   ON "Session"("userId", "revokedAt");
