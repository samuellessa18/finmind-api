-- FinMind — Migration 0003: Open Finance (Pluggy)
-- Apply with: npx prisma migrate deploy
-- Safe: all tables are new — no existing data is affected

-- BankConnection
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
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BankConnection"
  ADD CONSTRAINT "BankConnection_pluggyItemIdEnc_key"  UNIQUE ("pluggyItemIdEnc");
ALTER TABLE "BankConnection"
  ADD CONSTRAINT "BankConnection_pluggyItemIdHmac_key" UNIQUE ("pluggyItemIdHmac");

ALTER TABLE "BankConnection"
  ADD CONSTRAINT "BankConnection_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "BankConnection_userId_idx"        ON "BankConnection"("userId");
CREATE INDEX IF NOT EXISTS "BankConnection_userId_status_idx" ON "BankConnection"("userId", "status");
CREATE INDEX IF NOT EXISTS "BankConnection_consentExpiresAt_idx" ON "BankConnection"("consentExpiresAt");

-- BankAccount
CREATE TABLE IF NOT EXISTS "BankAccount" (
  "id"                  TEXT         NOT NULL,
  "connectionId"        TEXT         NOT NULL,
  "userId"              TEXT         NOT NULL,
  "pluggyAccountIdEnc"  TEXT         NOT NULL,
  "pluggyAccountIdHmac" TEXT         NOT NULL,
  "type"                TEXT         NOT NULL,
  "subtype"            TEXT,
  "name"               TEXT         NOT NULL,
  "number"             TEXT,
  "balance"            DOUBLE PRECISION NOT NULL DEFAULT 0,
  "balanceDate"        TIMESTAMP(3),
  "currencyCode"       TEXT         NOT NULL DEFAULT 'BRL',
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BankAccount"
  ADD CONSTRAINT "BankAccount_pluggyAccountIdEnc_key"  UNIQUE ("pluggyAccountIdEnc");
ALTER TABLE "BankAccount"
  ADD CONSTRAINT "BankAccount_pluggyAccountIdHmac_key" UNIQUE ("pluggyAccountIdHmac");

ALTER TABLE "BankAccount"
  ADD CONSTRAINT "BankAccount_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "BankConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BankAccount"
  ADD CONSTRAINT "BankAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "BankAccount_connectionId_idx" ON "BankAccount"("connectionId");
CREATE INDEX IF NOT EXISTS "BankAccount_userId_idx"       ON "BankAccount"("userId");

-- BankTransaction
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

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_pluggyTxId_key" UNIQUE ("pluggyTxId");

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "BankTransaction_accountId_date_idx"       ON "BankTransaction"("accountId", "date");
CREATE INDEX IF NOT EXISTS "BankTransaction_userId_date_idx"           ON "BankTransaction"("userId", "date");
CREATE INDEX IF NOT EXISTS "BankTransaction_userId_finmindCategory_idx" ON "BankTransaction"("userId", "finmindCategory");
CREATE INDEX IF NOT EXISTS "BankTransaction_importedTxId_idx"          ON "BankTransaction"("importedTxId");
