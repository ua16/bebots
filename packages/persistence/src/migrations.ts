import type { SqliteDatabase } from "./database.js";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "create_schema_migrations",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "create_bots",
    sql: `
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        persona TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "create_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        timeout_ms INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        exit_code INTEGER,
        summary TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: "create_run_events",
    sql: `
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: "create_conversations",
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        participants TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "create_messages",
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender TEXT,
        sender_type TEXT,
        sender_id TEXT,
        content TEXT NOT NULL,
        reply_to TEXT,
        thread_id TEXT,
        delivery_state TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id)
      );
    `,
  },
  {
    version: 7,
    name: "create_conversation_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        runtime_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_used_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id)
      );
    `,
  },
  {
    version: 8,
    name: "create_file_index",
    sql: `
      CREATE TABLE IF NOT EXISTS file_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT,
        content TEXT,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 9,
    name: "add_run_conversation_refs",
    sql: `
      ALTER TABLE runs ADD COLUMN conversation_id TEXT;
      ALTER TABLE runs ADD COLUMN conversation_session_id TEXT;
    `,
  },
  {
    version: 10,
    name: "file_index_unique_bot_path",
    sql: `
      -- Keep the oldest row per (bot_id, path), then enforce uniqueness so
      -- the repository can rely on ON CONFLICT upserts.
      DELETE FROM file_index
      WHERE id NOT IN (SELECT MIN(id) FROM file_index GROUP BY bot_id, path);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_file_index_bot_path
        ON file_index (bot_id, path);
    `,
  },
];

export function migrate(db: SqliteDatabase, now: () => number = () => Date.now()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row: unknown) => (row as { version: number }).version),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec(migration.sql);
    const insert = db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );
    insert.run(migration.version, migration.name, now());
  }
}

export function currentSchemaVersion(db: SqliteDatabase): number {
  try {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number | null;
    };
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}
