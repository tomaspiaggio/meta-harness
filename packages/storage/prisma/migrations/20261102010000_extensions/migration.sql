CREATE TABLE "extensions" (
    "id" TEXT NOT NULL,
    "activeRevision" INTEGER,
    "enabled" INTEGER NOT NULL DEFAULT 0,
    "config" TEXT NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "requiredLabels" TEXT,
    "webhookToken" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "extensions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "extension_revisions" (
    "extensionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "manifest" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" BIGINT NOT NULL,
    "decidedAt" BIGINT,

    CONSTRAINT "extension_revisions_pkey" PRIMARY KEY ("extensionId", "revision")
);

CREATE TABLE "extension_timers" (
    "extensionId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "nextAt" BIGINT NOT NULL,

    CONSTRAINT "extension_timers_pkey" PRIMARY KEY ("extensionId", "trigger")
);

CREATE TABLE "extension_runs" (
    "id" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "input" TEXT,
    "status" TEXT NOT NULL,
    "workerId" TEXT,
    "leaseUntil" BIGINT,
    "events" INTEGER NOT NULL DEFAULT 0,
    "logs" TEXT,
    "error" TEXT,
    "createdAt" BIGINT NOT NULL,
    "startedAt" BIGINT,
    "finishedAt" BIGINT,

    CONSTRAINT "extension_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "extension_runs_status" ON "extension_runs"("status", "createdAt");
CREATE INDEX "extension_runs_extension" ON "extension_runs"("extensionId", "createdAt");

CREATE TABLE "extension_state" (
    "extensionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "extension_state_pkey" PRIMARY KEY ("extensionId", "key")
);

CREATE TABLE "extension_events" (
    "id" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "url" TEXT,
    "data" TEXT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "extension_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "extension_events_extensionId_key_key" ON "extension_events"("extensionId", "key");
CREATE INDEX "extension_events_recent" ON "extension_events"("extensionId", "createdAt");

CREATE TABLE "extension_subscriptions" (
    "id" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "types" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "extension_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "extension_subscriptions_extensionId_sessionId_key" ON "extension_subscriptions"("extensionId", "sessionId");

CREATE TABLE "extension_deliveries" (
    "turnId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "events" INTEGER NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "extension_deliveries_pkey" PRIMARY KEY ("turnId")
);

ALTER TABLE "extension_revisions" ADD CONSTRAINT "extension_revisions_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extension_timers" ADD CONSTRAINT "extension_timers_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extension_runs" ADD CONSTRAINT "extension_runs_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extension_state" ADD CONSTRAINT "extension_state_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extension_events" ADD CONSTRAINT "extension_events_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extension_subscriptions" ADD CONSTRAINT "extension_subscriptions_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "extensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "extension_subscriptions" ADD CONSTRAINT "extension_subscriptions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
