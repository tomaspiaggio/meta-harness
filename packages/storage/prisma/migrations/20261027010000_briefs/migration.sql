CREATE TABLE "briefs" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "highlights" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "sources" TEXT NOT NULL,
    "turnId" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "briefs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "briefs_day_workspace" ON "briefs"("day", "workspaceId");

CREATE TABLE "brief_runs" (
    "day" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "turnId" TEXT,
    "activity" INTEGER NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "brief_runs_pkey" PRIMARY KEY ("day")
);
