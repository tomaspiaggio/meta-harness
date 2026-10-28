CREATE TABLE "owner_alerts" (
    "turnId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "owner_alerts_pkey" PRIMARY KEY ("turnId")
);
