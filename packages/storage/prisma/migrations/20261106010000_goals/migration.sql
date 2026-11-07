CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currently" TEXT NOT NULL,
    "etaAt" BIGINT,
    "startsWhen" TEXT NOT NULL,
    "steps" TEXT NOT NULL,
    "targets" TEXT NOT NULL,
    "targetNote" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "finishedAt" BIGINT,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "goals_workspace" ON "goals"("workspaceId", "status");

CREATE TABLE "goal_events" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "done" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "at" BIGINT NOT NULL,

    CONSTRAINT "goal_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "goal_events_goal" ON "goal_events"("goalId", "at");
CREATE INDEX "goal_events_at" ON "goal_events"("at");

CREATE TABLE "goal_links" (
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,

    CONSTRAINT "goal_links_pkey" PRIMARY KEY ("kind", "refId")
);
