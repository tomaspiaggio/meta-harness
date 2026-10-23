CREATE TABLE "worker_grants" ("workerId" TEXT PRIMARY KEY REFERENCES "workers"("id"), "turnId" TEXT NOT NULL REFERENCES "turns"("id"), "expiresAt" BIGINT NOT NULL);
