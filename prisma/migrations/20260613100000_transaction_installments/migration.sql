-- Compras parceladas (FinMind Web): metadados de parcelamento na Transaction.
-- Migração ADITIVA: colunas nullable — zero impacto em registros existentes.
ALTER TABLE "Transaction" ADD COLUMN "installmentGroupId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "installmentNumber" INTEGER;
ALTER TABLE "Transaction" ADD COLUMN "installmentCount" INTEGER;

CREATE INDEX "Transaction_userId_installmentGroupId_idx"
  ON "Transaction"("userId", "installmentGroupId");
