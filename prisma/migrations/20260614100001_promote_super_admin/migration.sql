-- [ADMIN] One-off: promove o usuário owner a super_admin (RBAC, sem validação por e-mail no runtime).
-- Idempotente; no máximo 1 linha (email UNIQUE); no-op se ausente ou já super_admin.
UPDATE "User" SET "role" = 'super_admin' WHERE "email" = 'samuellessa18@gmail.com';
