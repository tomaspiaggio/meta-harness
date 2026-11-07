ALTER TABLE "turns" ADD COLUMN "launchedAt" BIGINT;
ALTER TABLE "turns" ADD COLUMN "retries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "turns" ADD COLUMN "notBefore" BIGINT;
-- Turns already running may have started their agent: never rerun them.
UPDATE "turns" SET "launchedAt" = "createdAt" WHERE "status" = 'running';
