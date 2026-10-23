CREATE TABLE "telegram_inbox" ("id" TEXT PRIMARY KEY, "payload" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0, "leaseUntil" BIGINT, "error" TEXT, "createdAt" BIGINT NOT NULL);
CREATE INDEX "telegram_inbox_pending" ON "telegram_inbox"("status", "leaseUntil");
