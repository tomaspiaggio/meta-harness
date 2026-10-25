CREATE TABLE "session_notes" (
    "turnId" TEXT NOT NULL,
    "fromSessionId" TEXT NOT NULL,
    "toSessionId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "session_notes_pkey" PRIMARY KEY ("turnId")
);
CREATE INDEX "session_notes_pair" ON "session_notes"("fromSessionId", "toSessionId", "createdAt");
