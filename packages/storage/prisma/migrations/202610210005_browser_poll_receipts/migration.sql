CREATE TABLE "browser_polls" ("id" TEXT PRIMARY KEY, "workerId" TEXT NOT NULL REFERENCES "workers"("id"), "commands" TEXT NOT NULL, "createdAt" BIGINT NOT NULL);
