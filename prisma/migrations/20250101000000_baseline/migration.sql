-- ──────────────────────────────────────────────────────────────
-- FinMind — Baseline Migration
-- Este arquivo representa o estado completo do banco após
-- toda a história anterior (init + lgpd + open_finance).
--
-- NUNCA deve ser executado manualmente no banco de produção —
-- o banco já contém esse schema. Esta migration foi marcada
-- como aplicada via:
--   npx prisma migrate resolve --applied 20250101000000_baseline
-- ──────────────────────────────────────────────────────────────

-- ─── Core tables ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Environment" (
    "id"        TEXT         NOT NULL,
    "name"      TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Environment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "User" (
    "id"                  TEXT             NOT NULL,
    "name"                TEXT             NOT NULL,
    "email"               TEXT             NOT NULL,
    "password"            TEXT,
    "provider"            TEXT             NOT NULL DEFAULT 'local',
    "googleId"            TEXT,
    "avatarUrl"           TEXT,
    "monthlyIncome"       DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "streakDays"          INTEGER          NOT NULL DEFAULT 0,
    "xp"                  INTEGER          NOT NULL DEFAULT 0,
    "level"               INTEGER          NOT NULL DEFAULT 1,
    "isPremium"           BOOLEAN          NOT NULL DEFAULT false,
    "plan"                TEXT             NOT NULL DEFAULT 'free',
    "onboardingCompleted" BOOLEAN          NOT NULL DEFAULT false,
    "lastCheckIn"         TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "environmentId"       TEXT,
    "lgpdConsentAt"       TIMESTAMP(3),
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Transaction" (
    "id"          TEXT             NOT NULL,
    "userId"      TEXT             NOT NULL,
    "type"        TEXT             NOT NULL,
    "category"    TEXT             NOT NULL,
    "amount"      DOUBLE PRECISION NOT NULL,
    "date"        TIMESTAMP(3)     NOT NULL,
    "description" TEXT,
    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Goal" (
    "id"            TEXT             NOT NULL,
    "userId"        TEXT             NOT NULL,
    "title"         TEXT             NOT NULL,
    "type"          TEXT             NOT NULL DEFAULT 'general',
    "targetAmount"  DOUBLE PRECISION NOT NULL,
    "currentAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deadline"      TIMESTAMP(3)     NOT NULL,
    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Insight" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "message"   TEXT         NOT NULL,
    "type"      TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Insight_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DailySnapshot" (
    "id"                TEXT             NOT NULL,
    "userId"            TEXT             NOT NULL,
    "balance"           DOUBLE PRECISION NOT NULL,
    "monthlyExpenses"   DOUBLE PRECISION NOT NULL,
    "savingsRate"       DOUBLE PRECISION NOT NULL,
    "riskLevel"         TEXT             NOT NULL,
    "predictedExpenses" DOUBLE PRECISION NOT NULL,
    "createdAt"         TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Notification" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "title"     TEXT,
    "message"   TEXT         NOT NULL,
    "type"      TEXT         NOT NULL,
    "priority"  TEXT         NOT NULL DEFAULT 'low',
    "read"      BOOLEAN      NOT NULL DEFAULT false,
    "sendAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UserProfile" (
    "id"             TEXT         NOT NULL,
    "userId"         TEXT         NOT NULL,
    "spendingPattern" TEXT        NOT NULL,
    "riskTolerance"  TEXT         NOT NULL,
    "lastUpdated"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PatternAlert" (
    "id"         TEXT             NOT NULL,
    "userId"     TEXT             NOT NULL,
    "category"   TEXT             NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,
    "message"    TEXT             NOT NULL,
    "severity"   TEXT             NOT NULL,
    "detectedAt" TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PatternAlert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Event" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT,
    "type"      TEXT         NOT NULL,
    "category"  TEXT,
    "metadata"  TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AIUsage" (
    "id"     TEXT         NOT NULL,
    "userId" TEXT         NOT NULL,
    "date"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "count"  INTEGER      NOT NULL DEFAULT 0,
    CONSTRAINT "AIUsage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AuthCode" (
    "id"        TEXT         NOT NULL,
    "code"      TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "GrowthAction" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "ruleKey"   TEXT         NOT NULL DEFAULT 'legacy',
    "type"      TEXT         NOT NULL,
    "channel"   TEXT                  DEFAULT 'notification',
    "metadata"  TEXT,
    "status"    TEXT         NOT NULL DEFAULT 'pending',
    "isShadow"  BOOLEAN      NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GrowthAction_pkey" PRIMARY KEY ("id")
);

-- ─── Open Finance tables ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS "BankConnection" (
    "id"               TEXT         NOT NULL,
    "userId"           TEXT         NOT NULL,
    "pluggyItemIdEnc"  TEXT         NOT NULL,
    "pluggyItemIdHmac" TEXT         NOT NULL,
    "institutionId"    TEXT         NOT NULL,
    "institutionName"  TEXT         NOT NULL,
    "institutionLogo"  TEXT,
    "status"           TEXT         NOT NULL DEFAULT 'UPDATING',
    "errorCode"        TEXT,
    "errorMessage"     TEXT,
    "consentExpiresAt" TIMESTAMP(3),
    "lastSyncAt"       TIMESTAMP(3),
    "lastSyncTxCount"  INTEGER      NOT NULL DEFAULT 0,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BankAccount" (
    "id"                  TEXT             NOT NULL,
    "connectionId"        TEXT             NOT NULL,
    "userId"              TEXT             NOT NULL,
    "pluggyAccountIdEnc"  TEXT             NOT NULL,
    "pluggyAccountIdHmac" TEXT             NOT NULL,
    "type"                TEXT             NOT NULL,
    "subtype"             TEXT,
    "name"                TEXT             NOT NULL,
    "number"              TEXT,
    "balance"             DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balanceDate"         TIMESTAMP(3),
    "currencyCode"        TEXT             NOT NULL DEFAULT 'BRL',
    "createdAt"           TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BankTransaction" (
    "id"               TEXT             NOT NULL,
    "accountId"        TEXT             NOT NULL,
    "userId"           TEXT             NOT NULL,
    "pluggyTxId"       TEXT             NOT NULL,
    "date"             TIMESTAMP(3)     NOT NULL,
    "description"      TEXT             NOT NULL,
    "amount"           DOUBLE PRECISION NOT NULL,
    "currencyCode"     TEXT             NOT NULL DEFAULT 'BRL',
    "type"             TEXT             NOT NULL,
    "pluggyCategory"   TEXT,
    "finmindCategory"  TEXT,
    "merchant"         TEXT,
    "balance"          DOUBLE PRECISION,
    "importedTxId"     TEXT,
    "createdAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- ─── Unique constraints ────────────────────────────────────────

ALTER TABLE "User"
    ADD CONSTRAINT "User_email_key" UNIQUE ("email");
ALTER TABLE "User"
    ADD CONSTRAINT "User_googleId_key" UNIQUE ("googleId");
ALTER TABLE "AIUsage"
    ADD CONSTRAINT "AIUsage_userId_date_key" UNIQUE ("userId", "date");
ALTER TABLE "AuthCode"
    ADD CONSTRAINT "AuthCode_code_key" UNIQUE ("code");
ALTER TABLE "UserProfile"
    ADD CONSTRAINT "UserProfile_userId_key" UNIQUE ("userId");
ALTER TABLE "BankConnection"
    ADD CONSTRAINT "BankConnection_pluggyItemIdEnc_key"  UNIQUE ("pluggyItemIdEnc");
ALTER TABLE "BankConnection"
    ADD CONSTRAINT "BankConnection_pluggyItemIdHmac_key" UNIQUE ("pluggyItemIdHmac");
ALTER TABLE "BankAccount"
    ADD CONSTRAINT "BankAccount_pluggyAccountIdEnc_key"  UNIQUE ("pluggyAccountIdEnc");
ALTER TABLE "BankAccount"
    ADD CONSTRAINT "BankAccount_pluggyAccountIdHmac_key" UNIQUE ("pluggyAccountIdHmac");
ALTER TABLE "BankTransaction"
    ADD CONSTRAINT "BankTransaction_pluggyTxId_key" UNIQUE ("pluggyTxId");

-- ─── Indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "User_email_idx"                        ON "User"("email");
CREATE INDEX IF NOT EXISTS "User_googleId_idx"                     ON "User"("googleId");
CREATE INDEX IF NOT EXISTS "User_createdAt_idx"                    ON "User"("createdAt");
CREATE INDEX IF NOT EXISTS "Transaction_userId_idx"                ON "Transaction"("userId");
CREATE INDEX IF NOT EXISTS "Transaction_userId_date_idx"           ON "Transaction"("userId", "date");
CREATE INDEX IF NOT EXISTS "Transaction_userId_type_idx"           ON "Transaction"("userId", "type");
CREATE INDEX IF NOT EXISTS "Goal_userId_idx"                       ON "Goal"("userId");
CREATE INDEX IF NOT EXISTS "Insight_userId_idx"                    ON "Insight"("userId");
CREATE INDEX IF NOT EXISTS "Insight_userId_createdAt_idx"          ON "Insight"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "DailySnapshot_userId_createdAt_idx"    ON "DailySnapshot"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx"          ON "Notification"("userId", "read");
CREATE INDEX IF NOT EXISTS "PatternAlert_userId_idx"               ON "PatternAlert"("userId");
CREATE INDEX IF NOT EXISTS "Event_userId_idx"                      ON "Event"("userId");
CREATE INDEX IF NOT EXISTS "Event_type_idx"                        ON "Event"("type");
CREATE INDEX IF NOT EXISTS "Event_createdAt_idx"                   ON "Event"("createdAt");
CREATE INDEX IF NOT EXISTS "AIUsage_userId_date_idx"               ON "AIUsage"("userId", "date");
CREATE INDEX IF NOT EXISTS "AuthCode_expiresAt_idx"                ON "AuthCode"("expiresAt");
CREATE INDEX IF NOT EXISTS "AuthCode_userId_idx"                   ON "AuthCode"("userId");
CREATE INDEX IF NOT EXISTS "GrowthAction_userId_status_idx"        ON "GrowthAction"("userId", "status");
CREATE INDEX IF NOT EXISTS "BankConnection_userId_idx"             ON "BankConnection"("userId");
CREATE INDEX IF NOT EXISTS "BankConnection_userId_status_idx"      ON "BankConnection"("userId", "status");
CREATE INDEX IF NOT EXISTS "BankConnection_consentExpiresAt_idx"   ON "BankConnection"("consentExpiresAt");
CREATE INDEX IF NOT EXISTS "BankAccount_connectionId_idx"          ON "BankAccount"("connectionId");
CREATE INDEX IF NOT EXISTS "BankAccount_userId_idx"                ON "BankAccount"("userId");
CREATE INDEX IF NOT EXISTS "BankTransaction_accountId_date_idx"    ON "BankTransaction"("accountId", "date");
CREATE INDEX IF NOT EXISTS "BankTransaction_userId_date_idx"       ON "BankTransaction"("userId", "date");
CREATE INDEX IF NOT EXISTS "BankTransaction_userId_finmindCategory_idx" ON "BankTransaction"("userId", "finmindCategory");
CREATE INDEX IF NOT EXISTS "BankTransaction_importedTxId_idx"      ON "BankTransaction"("importedTxId");

-- ─── Foreign keys ──────────────────────────────────────────────

ALTER TABLE "User"
    ADD CONSTRAINT "User_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "Environment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Transaction"
    ADD CONSTRAINT "Transaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Goal"
    ADD CONSTRAINT "Goal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Insight"
    ADD CONSTRAINT "Insight_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DailySnapshot"
    ADD CONSTRAINT "DailySnapshot_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Notification"
    ADD CONSTRAINT "Notification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserProfile"
    ADD CONSTRAINT "UserProfile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PatternAlert"
    ADD CONSTRAINT "PatternAlert_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Event"
    ADD CONSTRAINT "Event_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AIUsage"
    ADD CONSTRAINT "AIUsage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GrowthAction"
    ADD CONSTRAINT "GrowthAction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BankConnection"
    ADD CONSTRAINT "BankConnection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BankAccount"
    ADD CONSTRAINT "BankAccount_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "BankConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BankAccount"
    ADD CONSTRAINT "BankAccount_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BankTransaction"
    ADD CONSTRAINT "BankTransaction_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "BankAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BankTransaction"
    ADD CONSTRAINT "BankTransaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
