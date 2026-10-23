import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { connectPostgres } from "./database";

const id = (value: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value))
    throw new Error("Unsafe database identifier.");
  return `"${value}"`;
};
type Cell = string | number | null;
type Table = { name: string; columns: string[]; rows: Record<string, Cell>[] };
export interface DatabaseExport {
  version: 1;
  createdAt: number;
  tables: Table[];
  checksum: string;
}
const digest = (tables: Table[]) =>
  createHash("sha256").update(JSON.stringify(tables)).digest("hex");
/** A consistent, read-only snapshot. This never modifies the source database. */
export function exportSqlite(path: string): DatabaseExport {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const ordered: string[] = [];
    const visiting = new Set<string>();
    const visit = (name: string) => {
      if (ordered.includes(name)) return;
      if (visiting.has(name))
        throw new Error(
          "Cyclic source foreign keys require a separate migration.",
        );
      visiting.add(name);
      for (const row of db
        .prepare(`PRAGMA foreign_key_list(${id(name)})`)
        .all())
        if (names.includes(String(row.table)) && row.table !== name)
          visit(String(row.table));
      visiting.delete(name);
      ordered.push(name);
    };
    for (const name of names) visit(name);
    const tables = ordered.map((name) => {
      const columns = db
        .prepare(`PRAGMA table_info(${id(name)})`)
        .all()
        .map((row) => String(row.name));
      const stableRowid = [
        "turns",
        "tasks",
        "checkpoints",
        "worker_claims",
      ].includes(name);
      if (stableRowid) columns.unshift("rowid");
      const rows = db
        .prepare(
          `SELECT ${columns.map(id).join(",")} FROM ${id(name)} ORDER BY rowid`,
        )
        .all() as Record<string, Cell>[];
      return { name, columns, rows };
    });
    db.exec("COMMIT");
    return {
      version: 1,
      createdAt: Date.now(),
      tables,
      checksum: digest(tables),
    };
  } finally {
    db.close();
  }
}
/** Import only into a fresh, migrated database; all rows and verification are atomic. */
export async function importPostgres(value: unknown, url: string) {
  const input = value as DatabaseExport;
  if (
    input?.version !== 1 ||
    !Array.isArray(input.tables) ||
    input.checksum !== digest(input.tables)
  )
    throw new Error("Invalid export or checksum.");
  const db = await connectPostgres(url);
  try {
    return await db.transaction(async () => {
      const target = await db
        .prepare(
          "SELECT table_name AS name, column_name AS column FROM information_schema.columns WHERE table_schema = current_schema()",
        )
        .all();
      for (const table of input.tables) {
        id(table.name);
        for (const column of table.columns) id(column);
        const allowed = target
          .filter((row) => row.name === table.name)
          .map((row) => String(row.column));
        if (
          !allowed.length ||
          table.columns.some((column) => !allowed.includes(column))
        )
          throw new Error(
            `Destination schema differs for ${table.name}. Run migrations first.`,
          );
        const count = await db
          .prepare(`SELECT COUNT(*) AS count FROM ${id(table.name)}`)
          .get();
        if (Number(count?.count) > 0)
          throw new Error(
            `Destination ${table.name} is not empty. Import into a fresh database.`,
          );
      }
      for (const table of input.tables) {
        const sql = `INSERT INTO ${id(table.name)} (${table.columns.map(id).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`;
        for (const row of table.rows) {
          if (
            Object.keys(row).length !== table.columns.length ||
            table.columns.some(
              (column) =>
                !(column in row) ||
                (row[column] !== null &&
                  typeof row[column] !== "number" &&
                  typeof row[column] !== "string"),
            )
          )
            throw new Error("Invalid export row.");
          await db
            .prepare(sql)
            .run(
              ...table.columns.map((column) => row[column] as SQLInputValue),
            );
        }
        const sort = (rows: Record<string, unknown>[]) =>
          rows
            .map((row) =>
              JSON.stringify(
                Object.fromEntries(
                  table.columns.map((column) => [column, row[column]]),
                ),
              ),
            )
            .sort();
        // rowid is intentionally stripped by the normal application driver; compare it
        // separately using an alias while verifying every application column.
        const projection = table.columns
          .map((column) =>
            column === "rowid" ? '"rowid" AS "transferSequence"' : id(column),
          )
          .join(",");
        const actual = await db
          .prepare(`SELECT ${projection} FROM ${id(table.name)}`)
          .all();
        const normalized = actual.map((row) =>
          Object.fromEntries(
            table.columns.map((column) => [
              column,
              column === "rowid" ? row.transferSequence : row[column],
            ]),
          ),
        );
        if (
          JSON.stringify(sort(normalized)) !== JSON.stringify(sort(table.rows))
        )
          throw new Error(
            `Verification failed for ${table.name}; transaction rolled back.`,
          );
        for (const column of table.columns) {
          const sequence = await db
            .prepare("SELECT pg_get_serial_sequence(?, ?) AS name")
            .get(table.name, column);
          if (sequence?.name)
            await db
              .prepare(
                `SELECT setval(?::regclass, COALESCE(MAX(${id(column)}),1), COUNT(*) > 0) FROM ${id(table.name)}`,
              )
              .get(sequence.name);
        }
      }
      return {
        tables: input.tables.length,
        rows: input.tables.reduce((sum, table) => sum + table.rows.length, 0),
        checksum: input.checksum,
      };
    });
  } finally {
    await db.close();
  }
}
