-- One-off (FinMind Web): promove o usuário de testes ao plano máximo (pro/premium).
--
-- Idempotente e segura para reaplicação:
--   * UPDATE atinge no máximo 1 linha — "email" tem constraint UNIQUE;
--   * no-op se o usuário não existir (0 linhas) ou já estiver em pro/premium;
--   * nenhum outro campo e nenhum outro usuário são tocados.
--
-- Efeito: isPremiumUser()/canUseAI() passam a liberar IA (insights/generate,
-- analytics/emotional) e o usageLimiter aplica o limite do plano pro (50/dia).
UPDATE "User"
SET    "isPremium" = true,
       "plan"      = 'pro'
WHERE  "email" = 'samuellessa18@gmail.com';
