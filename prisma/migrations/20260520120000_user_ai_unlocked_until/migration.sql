-- FinMind — Migration: add aiUnlockedUntil to User (FASE 3.3)
-- Apply with:    npx prisma migrate deploy
-- Reversibility: ALTER TABLE "User" DROP COLUMN IF EXISTS "aiUnlockedUntil";
--
-- Safety:
--   * Coluna NULLABLE, sem DEFAULT, sem backfill
--   * Em PostgreSQL ≥ 11, ADD COLUMN nullable é operação metadata-only:
--     sem rewrite de tabela, sem AccessExclusiveLock prolongado
--   * IF NOT EXISTS torna a migration idempotente
--   * Registros existentes recebem NULL (sem unlock ativo)
--
-- Propósito: armazenar a janela de tempo em que o usuário tem acesso
--            temporário a features de IA, concedida via recompensa
--            (ex: rewarded ad). Lógica de leitura/escrita virá na FASE 3.4.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "aiUnlockedUntil" TIMESTAMP(3);
