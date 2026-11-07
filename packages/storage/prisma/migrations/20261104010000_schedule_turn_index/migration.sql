-- Unread counts and notifications look up whether a turn is a scheduled run.
CREATE INDEX "schedule_occurrences_turn" ON "schedule_occurrences"("turnId");
