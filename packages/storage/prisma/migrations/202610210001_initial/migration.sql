-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "nativeId" TEXT,
    "createdAt" BIGINT NOT NULL,
    "titleSource" TEXT NOT NULL DEFAULT 'prompt',
    "readThroughSequence" BIGINT NOT NULL DEFAULT 0,
    "ownerWorkerId" TEXT,
    "checkpointId" TEXT,
    "nativeRevision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turns" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "runId" TEXT,
    "workerId" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" BIGINT,
    "output" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "createdAt" BIGINT NOT NULL,
    "stopRequestedAt" BIGINT,
    "interruptsTurnId" TEXT,
    "rowid" BIGSERIAL NOT NULL,

    CONSTRAINT "turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_attention" (
    "sequence" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "session_attention_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "report" TEXT,
    "seenAt" BIGINT,
    "draining" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "paused" INTEGER NOT NULL DEFAULT 0,
    "targetWorkerId" TEXT,
    "createdAt" BIGINT NOT NULL,
    "rowid" BIGSERIAL NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_events" (
    "turnId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "sequence" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "worker_events_pkey" PRIMARY KEY ("turnId","generation","sequence")
);

-- CreateTable
CREATE TABLE "checkpoints" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "nativeId" TEXT,
    "snapshot" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "nativeRevision" INTEGER NOT NULL DEFAULT 0,
    "rowid" BIGSERIAL NOT NULL,

    CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_claims" (
    "workerId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "turnId" TEXT,
    "generation" INTEGER,
    "createdAt" BIGINT NOT NULL,
    "rowid" BIGSERIAL NOT NULL,

    CONSTRAINT "worker_claims_pkey" PRIMARY KEY ("workerId","requestId")
);

-- CreateTable
CREATE TABLE "native_entries" (
    "sequence" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "subpath" TEXT NOT NULL,
    "uuid" TEXT,
    "data" TEXT NOT NULL,

    CONSTRAINT "native_entries_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "native_writes" (
    "sessionId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "native_writes_pkey" PRIMARY KEY ("sessionId","id")
);

-- CreateTable
CREATE TABLE "provider_cooldowns" (
    "workerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "retryAt" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "provider_cooldowns_pkey" PRIMARY KEY ("workerId","provider")
);

-- CreateTable
CREATE TABLE "decision_history" (
    "sequence" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT,
    "revision" INTEGER NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT,
    "turnId" TEXT,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "decision_history_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "turn_knowledge" (
    "turnId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,

    CONSTRAINT "turn_knowledge_pkey" PRIMARY KEY ("turnId","generation")
);

-- CreateIndex
CREATE UNIQUE INDEX "turns_rowid_key" ON "turns"("rowid");

-- CreateIndex
CREATE UNIQUE INDEX "session_attention_turnId_key" ON "session_attention"("turnId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_sessionId_key" ON "tasks"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_rowid_key" ON "tasks"("rowid");

-- CreateIndex
CREATE UNIQUE INDEX "checkpoints_rowid_key" ON "checkpoints"("rowid");

-- CreateIndex
CREATE UNIQUE INDEX "worker_claims_rowid_key" ON "worker_claims"("rowid");

-- CreateIndex
CREATE UNIQUE INDEX "native_entries_sessionId_subpath_uuid_key" ON "native_entries"("sessionId", "subpath", "uuid");

-- CreateIndex
CREATE UNIQUE INDEX "decision_history_key_revision_key" ON "decision_history"("key", "revision");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turns" ADD CONSTRAINT "turns_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_attention" ADD CONSTRAINT "session_attention_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_attention" ADD CONSTRAINT "session_attention_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_events" ADD CONSTRAINT "worker_events_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_claims" ADD CONSTRAINT "worker_claims_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_entries" ADD CONSTRAINT "native_entries_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_writes" ADD CONSTRAINT "native_writes_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_cooldowns" ADD CONSTRAINT "provider_cooldowns_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_history" ADD CONSTRAINT "decision_history_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_history" ADD CONSTRAINT "decision_history_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_history" ADD CONSTRAINT "decision_history_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turn_knowledge" ADD CONSTRAINT "turn_knowledge_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Application invariants that Prisma cannot express as ordinary model indexes.
CREATE UNIQUE INDEX one_running_turn_per_session ON turns("sessionId") WHERE status = 'running';
CREATE INDEX turns_queue ON turns(status, "createdAt", rowid);
CREATE INDEX turns_session ON turns("sessionId", "createdAt", rowid);
CREATE INDEX session_attention_session ON session_attention("sessionId", sequence);
CREATE INDEX checkpoints_session ON checkpoints("sessionId", "createdAt");
CREATE FUNCTION record_terminal_attention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('completed', 'failed', 'interrupted') AND OLD.status NOT IN ('completed', 'failed', 'interrupted') THEN
    INSERT INTO session_attention("sessionId", "turnId", "createdAt")
      VALUES (NEW."sessionId", NEW.id, FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
      ON CONFLICT ("turnId") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER terminal_turn_attention AFTER UPDATE OF status ON turns
  FOR EACH ROW EXECUTE FUNCTION record_terminal_attention();
