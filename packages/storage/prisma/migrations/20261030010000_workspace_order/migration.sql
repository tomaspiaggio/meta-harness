-- The owner's sidebar order; unordered workspaces follow by name.
ALTER TABLE "workspaces" ADD COLUMN "sortOrder" INTEGER;
