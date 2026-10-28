ALTER TABLE "sessions" ADD COLUMN "role" TEXT;
CREATE UNIQUE INDEX "one_planner_per_workspace" ON "sessions"("workspaceId") WHERE "role" = 'planner';
