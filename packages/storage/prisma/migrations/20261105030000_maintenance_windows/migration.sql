CREATE TABLE "maintenance_windows" (
    "id" TEXT NOT NULL,
    "startsAt" BIGINT NOT NULL,
    "endsAt" BIGINT NOT NULL,
    "workers" TEXT NOT NULL DEFAULT '[]',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" BIGINT NOT NULL,
    CONSTRAINT "maintenance_windows_pkey" PRIMARY KEY ("id")
);
