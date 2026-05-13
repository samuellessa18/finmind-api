-- [MÉDIO-6] LGPD: adicionar campo de consentimento ao User
-- Nullable para não quebrar usuários existentes (retrocompatível)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lgpdConsentAt" TIMESTAMP(3);

-- [MÉDIO-MAINT] Limpeza de AuthCodes expirados acumulados
-- Executa uma vez na migration para limpar registros antigos
DELETE FROM "AuthCode" WHERE "expiresAt" < NOW();
