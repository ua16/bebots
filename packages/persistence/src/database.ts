import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const initSqlJs = (await import("sql.js")).default as (config?: unknown) => Promise<unknown>;

export interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number };
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  save(): void;
}

export interface OpenDatabaseOptions {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
}

export async function openDatabase(
  filePath: string,
  options: OpenDatabaseOptions = {},
): Promise<SqliteDatabase> {
  if (options.fileMustExist && !existsSync(filePath)) {
    throw new Error(`Database file does not exist: ${filePath}`);
  }
  const requireFn = createRequire(import.meta.url);
  const wasmPath = requireFn.resolve("sql.js/dist/sql-wasm.wasm");
  const SQL = (await initSqlJs({ locateFile: () => wasmPath })) as {
    Database: new (data?: Uint8Array) => {
      run: (sql: string) => void;
      exec: (sql: string) => unknown;
      prepare: (sql: string) => {
        bind: (params: unknown[]) => void;
        step: () => boolean;
        getAsObject: () => Record<string, unknown>;
        reset: () => void;
        free: () => void;
        clearBindings?: () => void;
      };
      export: () => Uint8Array;
      getRowsModified: () => number;
      close: () => void;
    };
  };

  const db = existsSync(filePath) ? new SQL.Database(readFileSync(filePath)) : new SQL.Database();

  const persist = () => {
    const data = db.export();
    writeFileSync(filePath, Buffer.from(data));
  };

  // sql.js invalidates prepared statements after db.export() (which persist() calls),
  // so a prepared statement cannot be reused across calls. To provide a better-sqlite3-
  // like reusable interface, each wrapper method re-prepares the SQL on demand.
  const prepareWrapper = (sql: string): SqliteStatement => ({
    get: (...params: unknown[]) => {
      const stmt = db.prepare(sql);
      try {
        if (params.length > 0) stmt.bind(params);
        const hasRow = stmt.step();
        return hasRow ? stmt.getAsObject() : undefined;
      } finally {
        stmt.free();
      }
    },
    all: (...params: unknown[]) => {
      const stmt = db.prepare(sql);
      try {
        if (params.length > 0) stmt.bind(params);
        const rows: Record<string, unknown>[] = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        return rows;
      } finally {
        stmt.free();
      }
    },
    run: (...params: unknown[]) => {
      const stmt = db.prepare(sql);
      try {
        if (params.length > 0) stmt.bind(params);
        stmt.step();
        const changes = db.getRowsModified();
        persist();
        return { changes };
      } finally {
        stmt.free();
      }
    },
  });

  const wrapped: SqliteDatabase = {
    exec: (sql: string) => {
      db.exec(sql);
      persist();
    },
    prepare: (sql: string) => prepareWrapper(sql),
    close: () => {
      persist();
      db.close();
    },
    save: persist,
  };

  return wrapped;
}
