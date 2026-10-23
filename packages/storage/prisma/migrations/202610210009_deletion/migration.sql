CREATE TABLE "harness_settings" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL);
ALTER TABLE "decision_history" DROP CONSTRAINT "decision_history_workspaceId_fkey";
CREATE TABLE "deleted_resources" ("kind" TEXT NOT NULL, "id" TEXT NOT NULL, "createdAt" BIGINT NOT NULL, PRIMARY KEY("kind","id"));
CREATE TABLE "worker_cleanup" ("workerId" TEXT NOT NULL REFERENCES "workers"("id") ON DELETE RESTRICT ON UPDATE CASCADE, "kind" TEXT NOT NULL, "resourceId" TEXT NOT NULL, PRIMARY KEY("workerId","kind","resourceId"));
CREATE TABLE "cleanup_jobs" ("id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "payload" TEXT NOT NULL, "nextAt" BIGINT NOT NULL, "leaseUntil" BIGINT, "error" TEXT);
