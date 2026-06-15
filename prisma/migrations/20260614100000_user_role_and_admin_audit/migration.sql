-- [ADMIN/RBAC] Coluna de role no User + tabela de auditoria administrativa.
-- ADITIVA: role tem DEFAULT 'user' (registros existentes recebem 'user'); AdminAudit é nova.

ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';

CREATE TABLE "AdminAudit" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAudit_targetUserId_idx" ON "AdminAudit"("targetUserId");
CREATE INDEX "AdminAudit_adminId_idx" ON "AdminAudit"("adminId");
CREATE INDEX "AdminAudit_createdAt_idx" ON "AdminAudit"("createdAt");
