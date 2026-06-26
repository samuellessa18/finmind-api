-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatTurn" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ADMITTED',
    "dayKey" TEXT NOT NULL,
    "providerCallStartedAt" TIMESTAMP(3),
    "billedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "usageInputTokens" INTEGER,
    "usageOutputTokens" INTEGER,
    "usageToolInputTokens" INTEGER,
    "usageToolOutputTokens" INTEGER,
    "costMicroUSD" DECIMAL(65,30),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT,
    "assistantMessageSeq" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "tokensInput" INTEGER NOT NULL DEFAULT 0,
    "tokensOutput" INTEGER NOT NULL DEFAULT 0,
    "tokensCacheRead" INTEGER NOT NULL DEFAULT 0,
    "tokensCacheCreation" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatErasureAudit" (
    "id" TEXT NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "mode" TEXT NOT NULL,
    "chatConversationsDeleted" INTEGER NOT NULL DEFAULT 0,
    "chatTurnsDeleted" INTEGER NOT NULL DEFAULT 0,
    "chatMessagesDeleted" INTEGER NOT NULL DEFAULT 0,
    "chatUsageRowsDeleted" INTEGER NOT NULL DEFAULT 0,
    "consentRecordsDeleted" INTEGER NOT NULL DEFAULT 0,
    "consentScopeHash" TEXT,
    "consentTimestamp" TIMESTAMP(3),
    "externalActionsPerformed" TEXT,
    "erasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pruneEligibleAt" TIMESTAMP(3),

    CONSTRAINT "ChatErasureAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserConsent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatConversation_userId_updatedAt_idx" ON "ChatConversation"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatConversation_userId_archivedAt_idx" ON "ChatConversation"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "ChatConversation_createdAt_idx" ON "ChatConversation"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatConversation_id_userId_key" ON "ChatConversation"("id", "userId");

-- CreateIndex
CREATE INDEX "ChatTurn_userId_updatedAt_idx" ON "ChatTurn"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatTurn_conversationId_seq_key" ON "ChatTurn"("conversationId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatTurn_conversationId_idempotencyKey_key" ON "ChatTurn"("conversationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChatTurn_id_userId_key" ON "ChatTurn"("id", "userId");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_userId_createdAt_idx" ON "ChatMessage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_createdAt_idx" ON "ChatMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_turnId_seq_key" ON "ChatMessage"("turnId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_conversationId_assistantMessageSeq_key" ON "ChatMessage"("conversationId", "assistantMessageSeq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatUsage_userId_dayKey_key" ON "ChatUsage"("userId", "dayKey");

-- CreateIndex
CREATE INDEX "ChatErasureAudit_subjectUserId_idx" ON "ChatErasureAudit"("subjectUserId");

-- CreateIndex
CREATE INDEX "ChatErasureAudit_erasedAt_idx" ON "ChatErasureAudit"("erasedAt");

-- CreateIndex
CREATE INDEX "ChatErasureAudit_pruneEligibleAt_idx" ON "ChatErasureAudit"("pruneEligibleAt");

-- CreateIndex
CREATE INDEX "UserConsent_userId_scope_idx" ON "UserConsent"("userId", "scope");

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatTurn" ADD CONSTRAINT "ChatTurn_conversationId_userId_fkey" FOREIGN KEY ("conversationId", "userId") REFERENCES "ChatConversation"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatTurn" ADD CONSTRAINT "ChatTurn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_turnId_userId_fkey" FOREIGN KEY ("turnId", "userId") REFERENCES "ChatTurn"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatUsage" ADD CONSTRAINT "ChatUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserConsent" ADD CONSTRAINT "UserConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ──────────────────────────────────────────────────────────────
-- Consultor v1.2 / Apêndice C — DDL que o Prisma 5 NÃO emite:
-- (1) índice PARCIAL de reconciliação (só turnos em voo; auto-limpante)
-- (2) CHECK de coerência financeira billedAt <=> BILLED
-- ──────────────────────────────────────────────────────────────
CREATE INDEX "ChatTurn_reconciliation_idx"
  ON "ChatTurn" ("state", "updatedAt")
  WHERE "state" IN ('ADMITTED', 'DISPATCHING');

ALTER TABLE "ChatTurn"
  ADD CONSTRAINT "ChatTurn_billed_consistency_chk"
  CHECK (("state" = 'BILLED') = ("billedAt" IS NOT NULL));
