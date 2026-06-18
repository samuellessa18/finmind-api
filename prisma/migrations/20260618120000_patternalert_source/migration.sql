-- [ORÇAMENTO] Discriminador de origem do PatternAlert.
-- Aditiva e compatível: ADD COLUMN com DEFAULT backfilla registros antigos como
-- 'PATTERN' (antes desta fase TODO PatternAlert era alerta de padrão).
ALTER TABLE "PatternAlert" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'PATTERN';

-- Índice de apoio à deduplicação por origem (userId + category + source; o filtro
-- por mês em detectedAt é aplicado em memória sobre este conjunto pequeno).
CREATE INDEX "PatternAlert_userId_category_source_idx" ON "PatternAlert"("userId", "category", "source");
