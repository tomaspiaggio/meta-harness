CREATE TABLE delegations (
 id TEXT PRIMARY KEY, "fromSessionId" TEXT NOT NULL, "toSessionId" TEXT NOT NULL, title TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open', rounds INTEGER NOT NULL DEFAULT 1, progress TEXT, "progressAt" BIGINT,
 "reportStatus" TEXT, report TEXT, "reportAt" BIGINT, "closedNote" TEXT, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL
);
CREATE INDEX delegations_from ON delegations("fromSessionId");
CREATE INDEX delegations_to ON delegations("toSessionId");
CREATE TABLE delegation_turns (
 "turnId" TEXT PRIMARY KEY, "delegationId" TEXT NOT NULL, role TEXT NOT NULL, round INTEGER NOT NULL,
 "reportStatus" TEXT, report TEXT, "reportedAt" BIGINT, "createdAt" BIGINT NOT NULL
);
CREATE INDEX delegation_turns_delegation ON delegation_turns("delegationId");
