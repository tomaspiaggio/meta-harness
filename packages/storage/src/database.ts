import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Prisma, PrismaClient } from "../generated/prisma/client";

type Row = Record<string, string | number | null>;
export interface Statement {
  get(...values: SQLInputValue[]): Promise<Row | undefined>;
  all(...values: SQLInputValue[]): Promise<Row[]>;
  run(...values: SQLInputValue[]): Promise<{
    changes: number;
  }>;
}
export interface SqlDatabase {
  prepare(sql: string): Statement;
  transaction<T>(action: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
// Serialize access to a SQLite file, including reads during async transactions.
// Another connection in this process must not block the event loop on BEGIN while
// the transaction owning the write lock is suspended at an await.
const gates = new Map<string, Promise<void>>();
export class LocalDatabase implements SqlDatabase {
  private context = new AsyncLocalStorage<boolean>();
  private key: string;
  constructor(
    readonly raw: DatabaseSync,
    path: string,
  ) {
    this.key = path === ":memory:" ? crypto.randomUUID() : resolve(path);
  }
  private async gate<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return action();
    const previous = gates.get(this.key) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((done) => {
      release = done;
    });
    gates.set(this.key, next);
    await previous;
    try {
      return await this.context.run(true, action);
    } finally {
      release();
      if (gates.get(this.key) === next) gates.delete(this.key);
    }
  }
  prepare(sql: string): Statement {
    return {
      get: (...values) =>
        this.gate(
          () => this.raw.prepare(sql).get(...values) as Row | undefined,
        ),
      all: (...values) =>
        this.gate(() => this.raw.prepare(sql).all(...values) as Row[]),
      run: (...values) =>
        this.gate(() => ({
          changes: Number(this.raw.prepare(sql).run(...values).changes),
        })),
    };
  }
  transaction<T>(action: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return action();
    return this.gate(async () => {
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await action();
        this.raw.exec("COMMIT");
        return result;
      } catch (error) {
        this.raw.exec("ROLLBACK");
        throw error;
      }
    });
  }
  async close() {
    await this.gate(() => this.raw.close());
  }
}
/** Only application-authored SQL enters this function. Values remain bound. */
export function postgresSql(input: string): string {
  let sql = input.replace(
    /length\(CAST\(([^()]+) AS BLOB\)\)/gi,
    "octet_length(($1)::text)",
  );
  const ignored = /INSERT OR IGNORE/i.test(sql);
  sql = sql.replace(/INSERT OR IGNORE/gi, "INSERT");
  // SQLite's multi-argument MAX is PostgreSQL's GREATEST; aggregate MAX stays MAX.
  let output = "";
  for (let i = 0; i < sql.length; ) {
    if (sql[i] === "'") {
      let end = i + 1;
      while (end < sql.length) {
        if (sql[end++] === "'") {
          if (sql[end] === "'") {
            end++;
            continue;
          }
          break;
        }
      }
      output += sql.slice(i, end);
      i = end;
      continue;
    }
    if (
      /^MAX\s*\(/i.test(sql.slice(i)) &&
      (i === 0 || !/\w/.test(sql[i - 1]))
    ) {
      const start = sql.indexOf("(", i);
      let depth = 1;
      let comma = false;
      let quoted = false;
      for (let j = start + 1; j < sql.length && depth; j++) {
        if (sql[j] === "'") {
          if (quoted && sql[j + 1] === "'") {
            j++;
            continue;
          }
          quoted = !quoted;
        }
        if (!quoted) {
          if (sql[j] === "(") depth++;
          if (sql[j] === ")") depth--;
          if (depth === 1 && sql[j] === ",") comma = true;
        }
      }
      output += comma ? "GREATEST" : "MAX";
      i = start;
      continue;
    }
    output += sql[i++];
  }
  let parameter = 0;
  output = output.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|\b[a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*\b|\?/g,
    (token) => {
      if (token.startsWith("'") || token.startsWith('"')) return token;
      if (token === "?") return `$${++parameter}`;
      return `"${token}"`;
    },
  );
  if (ignored) output = `${output.replace(/;\s*$/, "")} ON CONFLICT DO NOTHING`;
  // PostgreSQL requires a name for this derived table on older supported releases.
  output = output.replace(
    /\) ORDER BY createdAt$/,
    ') AS history ORDER BY "createdAt"',
  );
  return output;
}
function rows(value: unknown): Row[] {
  return (value as Record<string, unknown>[]).map(
    (row) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => key !== "rowid")
          .map(([key, item]) => {
            if (typeof item === "bigint") {
              const number = Number(item);
              if (!Number.isSafeInteger(number))
                throw new Error(
                  "Database integer exceeds the application range.",
                );
              return [key, number];
            }
            return [key, item];
          }),
      ) as Row,
  );
}
export class PrismaDatabase implements SqlDatabase {
  private context = new AsyncLocalStorage<Prisma.TransactionClient>();
  constructor(readonly client: PrismaClient) {}
  prepare(input: string): Statement {
    const sql = postgresSql(input);
    const all = async (...values: SQLInputValue[]) =>
      rows(
        await (this.context.getStore() ?? this.client).$queryRawUnsafe(
          sql,
          ...values,
        ),
      );
    return {
      all,
      get: async (...values) => (await all(...values))[0],
      run: async (...values) => ({
        changes: await (
          this.context.getStore() ?? this.client
        ).$executeRawUnsafe(sql, ...values),
      }),
    };
  }
  async transaction<T>(action: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return action();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.$transaction(
          (tx) => this.context.run(tx, action),
          { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 },
        );
      } catch (error) {
        if (attempt >= 4 || !serializationConflict(error)) throw error;
        await new Promise((done) => setTimeout(done, 20 * 2 ** attempt));
      }
    }
  }
  async close() {
    await this.client.$disconnect();
  }
}

function serializationConflict(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 6) return false;
  const record = error as Record<string, unknown>;
  if (
    [record.code, record.originalCode].some(
      (code) => code === "P2034" || code === "40001" || code === "40P01",
    )
  )
    return true;
  return ["cause", "meta", "driverAdapterError", "error"].some((key) =>
    serializationConflict(record[key], depth + 1),
  );
}
export async function connectPostgres(url: string): Promise<PrismaDatabase> {
  const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
    import("../generated/prisma/client"),
    import("@prisma/adapter-pg"),
  ]);
  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    }),
  });
  try {
    await client.$connect();
  } catch (error) {
    await client.$disconnect().catch(() => {});
    throw error;
  }
  return new PrismaDatabase(client);
}
