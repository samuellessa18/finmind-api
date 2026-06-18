-- [SCORE] Histórico do Score Financeiro no snapshot diário.
-- ADITIVA: colunas nullable — zero impacto em snapshots existentes.
ALTER TABLE "DailySnapshot" ADD COLUMN "score" INTEGER;
ALTER TABLE "DailySnapshot" ADD COLUMN "scoreBreakdown" JSONB;
