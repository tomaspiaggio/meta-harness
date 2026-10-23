import { readFile, writeFile } from "node:fs/promises";
import {
  exportSqlite,
  importPostgres,
} from "../packages/storage/src/transfer.ts";

const [action, source, destination] = process.argv.slice(2);
if (action === "export" && source && destination) {
  const snapshot = exportSqlite(source);
  await writeFile(destination, JSON.stringify(snapshot), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `Exported ${snapshot.tables.length} tables. Treat this file as a private backup.`,
  );
} else if (action === "import" && source && process.env.DATABASE_URL) {
  const result = await importPostgres(
    JSON.parse(await readFile(source, "utf8")),
    process.env.DATABASE_URL,
  );
  console.log(result);
} else
  throw new Error(
    "Use pnpm db:transfer export /path/source.sqlite /path/private-export.json, or DATABASE_URL=... pnpm db:transfer import /path/private-export.json. Destination must be fresh and migrated.",
  );
