CREATE TABLE "workflow_waiters" ("runId" TEXT PRIMARY KEY, "turnId" TEXT NOT NULL REFERENCES "turns"("id"), "createdAt" BIGINT NOT NULL, "deliveredAt" BIGINT);
CREATE INDEX "workflow_waiters_turn" ON "workflow_waiters"("turnId", "deliveredAt");
