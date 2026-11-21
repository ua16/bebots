import { avatarForMigration, serializeBotAvatar } from "@bebots/domain";
import type { SqliteDatabase } from "./database.js";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql?: string;
  readonly run?: (db: SqliteDatabase) => void;
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
  {
    version: 11,
    name: "create_tasks",
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        requester TEXT,
        assignee TEXT NOT NULL,
        description TEXT NOT NULL,
        input_refs TEXT NOT NULL DEFAULT '[]',
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        deadline INTEGER,
        result_run_id TEXT,
        result_summary TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency_key ON tasks (idempotency_key);
    `,
  },
  {
    version: 12,
    name: "create_activity_events",
    sql: `
      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        actor_id TEXT,
        payload TEXT,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 13,
    name: "add_run_task_id",
    sql: `ALTER TABLE runs ADD COLUMN task_id TEXT;`,
  },
  {
    version: 14,
    name: "bot_model_and_app_settings",
    sql: `
      ALTER TABLE bots ADD COLUMN model TEXT NOT NULL DEFAULT '';
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 15,
    name: "sessions_per_bot",
    sql: `
      -- Resumable sessions are scoped per (conversation, bot): one bot's run
      -- must never resume another bot's OpenCode session in the same thread.
      ALTER TABLE conversation_sessions ADD COLUMN bot_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_conversation_sessions_conversation_bot
        ON conversation_sessions (conversation_id, bot_id);
    `,
  },
  {
    version: 16,
    name: "create_schedules",
    sql: `
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        trigger TEXT NOT NULL,
        conversation_id TEXT,
        created_by TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        anchor_at INTEGER NOT NULL,
        next_run_at INTEGER,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_due
        ON schedules (enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_bot
        ON schedules (bot_id);
      CREATE INDEX IF NOT EXISTS idx_schedules_created_by
        ON schedules (created_by);

      CREATE TABLE IF NOT EXISTS schedule_occurrences (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- Idempotent enqueueing: one occurrence per (schedule, scheduled time).
      -- Conflicting inserts return the existing row untouched.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_occurrences_slot
        ON schedule_occurrences (schedule_id, scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_schedule_occurrences_status
        ON schedule_occurrences (status);
      CREATE INDEX IF NOT EXISTS idx_schedule_occurrences_run
        ON schedule_occurrences (run_id);
    `,
  },
  {
    version: 17,
    name: "bots_avatar",
    sql: `ALTER TABLE bots ADD COLUMN avatar TEXT NOT NULL DEFAULT '';`,
    run: (db) => {
      const rows = db.prepare("SELECT id FROM bots").all() as unknown as { id: string }[];
      const update = db.prepare("UPDATE bots SET avatar = ? WHERE id = ?");
      for (const row of rows) {
        update.run(serializeBotAvatar(avatarForMigration(row.id)), row.id);
      }
    },
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
    if (migration.sql) db.exec(migration.sql);
    migration.run?.(db);
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
