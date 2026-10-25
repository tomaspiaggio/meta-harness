CREATE TABLE push_subscriptions (
 endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT NOT NULL,
 results INTEGER NOT NULL DEFAULT 0, "createdAt" BIGINT NOT NULL, "lastSeenAt" BIGINT NOT NULL,
 "lastSentAt" BIGINT, error TEXT
);
