-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "maxLatenessMs" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "nextAt" BIGINT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_occurrences" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "plannedAt" BIGINT NOT NULL,
    "firedAt" BIGINT NOT NULL,
    "turnId" TEXT,
    "outcome" TEXT NOT NULL,

    CONSTRAINT "schedule_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turn_attachments" (
    "turnId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,

    CONSTRAINT "turn_attachments_pkey" PRIMARY KEY ("turnId","attachmentId")
);

-- CreateTable
CREATE TABLE "channel_bindings" (
    "sessionId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "topicId" TEXT,
    "title" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "channel_bindings_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAt" BIGINT NOT NULL,
    "leaseUntil" BIGINT,
    "receipt" TEXT,
    "error" TEXT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_identities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "mode" TEXT NOT NULL DEFAULT 'agent',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" BIGINT,
    "userPublicKey" TEXT,
    "expiresAt" BIGINT,
    "lastUrl" TEXT,
    "frame" TEXT,
    "frameAt" BIGINT,
    "error" TEXT,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "browser_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_commands" (
    "id" TEXT NOT NULL,
    "browserId" TEXT NOT NULL,
    "turnId" TEXT,
    "turnGeneration" INTEGER,
    "browserGeneration" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "arguments" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "error" TEXT,
    "createdAt" BIGINT NOT NULL,
    "completedAt" BIGINT,

    CONSTRAINT "browser_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_sessions" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "owner_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oidc_states" (
    "id" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" BIGINT NOT NULL,

    CONSTRAINT "oidc_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "input_requests" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "response" TEXT,
    "createdAt" BIGINT NOT NULL,
    "resolvedAt" BIGINT,

    CONSTRAINT "input_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_resources" (
    "workspaceId" TEXT NOT NULL,
    "policy" TEXT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "workspace_resources_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "sandbox_jobs" (
    "id" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "workerId" TEXT,
    "sandboxId" TEXT,
    "status" TEXT NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    "error" TEXT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "sandbox_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_ledger" (
    "id" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "receipt" TEXT,
    "error" TEXT,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "operation_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "title_jobs" (
    "sessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" BIGINT,
    "error" TEXT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "title_jobs_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "telegram_updates" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "result" TEXT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "telegram_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_wakes" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "dueAt" BIGINT NOT NULL,
    "runId" TEXT,
    "leaseUntil" BIGINT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "schedule_wakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_wakeups" (
    "turnId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "deliveredAt" BIGINT,

    CONSTRAINT "workflow_wakeups_pkey" PRIMARY KEY ("turnId")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_bindings_platform_chatId_topicId_key" ON "channel_bindings"("platform", "chatId", "topicId");

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turn_attachments" ADD CONSTRAINT "turn_attachments_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turn_attachments" ADD CONSTRAINT "turn_attachments_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_bindings" ADD CONSTRAINT "channel_bindings_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_identities" ADD CONSTRAINT "browser_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_commands" ADD CONSTRAINT "browser_commands_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_commands" ADD CONSTRAINT "browser_commands_browserId_fkey" FOREIGN KEY ("browserId") REFERENCES "browser_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "input_requests" ADD CONSTRAINT "input_requests_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "input_requests" ADD CONSTRAINT "input_requests_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_resources" ADD CONSTRAINT "workspace_resources_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_jobs" ADD CONSTRAINT "sandbox_jobs_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_ledger" ADD CONSTRAINT "operation_ledger_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "title_jobs" ADD CONSTRAINT "title_jobs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_wakes" ADD CONSTRAINT "schedule_wakes_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_wakeups" ADD CONSTRAINT "workflow_wakeups_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX schedules_due ON schedules(status, "nextAt");
CREATE INDEX notifications_due ON notification_outbox(status, "nextAt");
CREATE INDEX browser_commands_queue ON browser_commands(status, "createdAt");
CREATE FUNCTION record_terminal_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('completed', 'failed', 'interrupted') AND OLD.status NOT IN ('completed', 'failed', 'interrupted') THEN
  INSERT INTO notification_outbox(id, "sessionId", kind, "referenceId", "nextAt", "createdAt")
  VALUES ('turn:' || NEW.id, NEW."sessionId", NEW.status, NEW.id, FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint, FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint) ON CONFLICT (id) DO NOTHING;
  INSERT INTO workflow_wakeups("turnId", "createdAt") VALUES (NEW.id, FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint) ON CONFLICT ("turnId") DO NOTHING;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER terminal_turn_notification AFTER UPDATE OF status ON turns FOR EACH ROW EXECUTE FUNCTION record_terminal_notification();
