import type { Bot, BotId } from "@bebots/domain";
import type {
  Run,
  RunId,
  RunStatus,
  Task,
  TaskId,
  TaskStatus,
  ActivityEvent,
  Schedule,
  ScheduleId,
  ScheduleOccurrence,
  ScheduleOccurrenceStatus,
} from "@bebots/domain";
import type {
  Conversation,
  ConversationId,
  ConversationKind,
  Message,
  MessageId,
  ConversationSession,
  ConversationSessionId,
} from "@bebots/domain";
import type { Effect } from "effect";
import type { NotFoundError, RepositoryError, WorkspaceError } from "./errors.js";

export interface BotRepository {
  readonly create: (bot: Bot) => Effect.Effect<Bot, RepositoryError>;
  readonly findById: (id: BotId) => Effect.Effect<Bot | null, RepositoryError>;
  readonly findAll: (options?: {
    readonly includeArchived?: boolean;
  }) => Effect.Effect<readonly Bot[], RepositoryError>;
  readonly update: (bot: Bot) => Effect.Effect<Bot, RepositoryError | NotFoundError>;
  readonly delete: (id: BotId) => Effect.Effect<void, RepositoryError | NotFoundError>;
}

/** Result of a bulk delete: how many rows the statement removed. */
export type DeleteCount = number;

export interface RunRepository {
  readonly create: (run: Run) => Effect.Effect<Run, RepositoryError>;
  readonly findById: (id: RunId) => Effect.Effect<Run | null, RepositoryError>;
  readonly findAll: (options?: {
    readonly botId?: BotId;
    readonly status?: RunStatus;
    readonly conversationId?: ConversationId;
    readonly limit?: number;
  }) => Effect.Effect<readonly Run[], RepositoryError>;
  readonly update: (run: Run) => Effect.Effect<Run, RepositoryError | NotFoundError>;
  readonly appendEvent: (
    runId: RunId,
    event: { readonly _tag: string; readonly [key: string]: unknown },
  ) => Effect.Effect<void, RepositoryError>;
  readonly listEvents: (
    runId: RunId,
  ) => Effect.Effect<
    readonly { readonly tag: string; readonly payload: unknown; readonly createdAt: number }[],
    RepositoryError
  >;
  /** Delete every run of a bot and its run_events; returns the run rows deleted. */
  readonly deleteByBot: (botId: BotId) => Effect.Effect<DeleteCount, RepositoryError>;
  /** Delete every run in a conversation (any bot) and its run_events; returns run rows deleted. */
  readonly deleteByConversation: (
    conversationId: ConversationId,
  ) => Effect.Effect<DeleteCount, RepositoryError>;
}

export interface ConversationRepository {
  readonly create: (conversation: Conversation) => Effect.Effect<Conversation, RepositoryError>;
  readonly findById: (id: ConversationId) => Effect.Effect<Conversation | null, RepositoryError>;
  readonly findAll: (options?: {
    readonly kind?: ConversationKind;
    readonly participant?: string;
    readonly limit?: number;
  }) => Effect.Effect<readonly Conversation[], RepositoryError>;
  readonly update: (
    conversation: Conversation,
  ) => Effect.Effect<Conversation, RepositoryError | NotFoundError>;
  readonly delete: (id: ConversationId) => Effect.Effect<void, RepositoryError | NotFoundError>;
}

export interface MessageRepository {
  readonly create: (message: Message) => Effect.Effect<Message, RepositoryError>;
  readonly findById: (id: MessageId) => Effect.Effect<Message | null, RepositoryError>;
  readonly findByConversation: (
    conversationId: ConversationId,
    options?: { readonly limit?: number; readonly before?: number },
  ) => Effect.Effect<readonly Message[], RepositoryError>;
  readonly findAll: (options?: {
    readonly conversationId?: ConversationId;
    readonly limit?: number;
  }) => Effect.Effect<readonly Message[], RepositoryError>;
  readonly update: (message: Message) => Effect.Effect<Message, RepositoryError | NotFoundError>;
  readonly delete: (id: MessageId) => Effect.Effect<void, RepositoryError | NotFoundError>;
  /** Delete every message of a conversation; returns rows deleted (0 when none). */
  readonly deleteByConversation: (
    conversationId: ConversationId,
  ) => Effect.Effect<DeleteCount, RepositoryError>;
}

export interface ConversationSessionRepository {
  readonly create: (
    session: ConversationSession,
  ) => Effect.Effect<ConversationSession, RepositoryError>;
  readonly findById: (
    id: ConversationSessionId,
  ) => Effect.Effect<ConversationSession | null, RepositoryError>;
  readonly findLatestByConversation: (
    conversationId: ConversationId,
    options?: {
      readonly status?: ConversationSession["status"];
      /** Restrict to sessions belonging to this bot; `null` matches unattributed (legacy) rows only. */
      readonly botId?: string | null;
    },
  ) => Effect.Effect<ConversationSession | null, RepositoryError>;
  readonly findAll: (options?: {
    readonly conversationId?: ConversationId;
    readonly status?: ConversationSession["status"];
    readonly limit?: number;
  }) => Effect.Effect<readonly ConversationSession[], RepositoryError>;
  readonly update: (
    session: ConversationSession,
  ) => Effect.Effect<ConversationSession, RepositoryError | NotFoundError>;
  readonly delete: (
    id: ConversationSessionId,
  ) => Effect.Effect<void, RepositoryError | NotFoundError>;
  /** Delete every session record of a conversation (all bots); returns rows deleted. */
  readonly deleteByConversation: (
    conversationId: ConversationId,
  ) => Effect.Effect<DeleteCount, RepositoryError>;
  /** Delete every session record scoped to a bot, across conversations; returns rows deleted. */
  readonly deleteByBot: (botId: BotId) => Effect.Effect<DeleteCount, RepositoryError>;
}

export interface FileIndexEntry {
  readonly botId: BotId;
  /** Path relative to the bots root, using forward slashes. */
  readonly path: string;
  /** Workspace segment the file lives in: `notes`, `memory`, or `logs`. */
  readonly kind: string;
  readonly content: string;
  readonly updatedAt: number;
}

export interface FileIndexSearchHit {
  readonly botId: BotId;
  readonly path: string;
  readonly snippet: string;
}

export interface FileIndexRepository {
  readonly upsert: (entry: FileIndexEntry) => Effect.Effect<FileIndexEntry, RepositoryError>;
  readonly remove: (botId: BotId, path: string) => Effect.Effect<void, RepositoryError>;
  /** Remove all indexed paths under (or equal to) the given relative directory path. */
  readonly removeUnderPrefix: (
    botId: BotId,
    pathPrefix: string,
  ) => Effect.Effect<number, RepositoryError>;
  /** Remove every indexed entry of a bot (bot deletion); returns rows deleted. */
  readonly removeByBot: (botId: BotId) => Effect.Effect<number, RepositoryError>;
  readonly search: (
    query: string,
    botId?: BotId,
  ) => Effect.Effect<readonly FileIndexSearchHit[], RepositoryError>;
}

export interface TaskRepository {
  readonly create: (task: Task) => Effect.Effect<Task, RepositoryError>;
  readonly findById: (id: TaskId) => Effect.Effect<Task | null, RepositoryError>;
  readonly findAll: (options?: {
    readonly requester?: string;
    readonly assignee?: string;
    readonly status?: TaskStatus;
    readonly limit?: number;
  }) => Effect.Effect<readonly Task[], RepositoryError>;
  readonly update: (task: Task) => Effect.Effect<Task, RepositoryError | NotFoundError>;
  readonly delete: (id: TaskId) => Effect.Effect<void, RepositoryError | NotFoundError>;
  readonly findByIdempotencyKey: (key: string) => Effect.Effect<Task | null, RepositoryError>;
  /**
   * Delete every task whose requester or assignee is the given bot (bot
   * deletion); returns rows deleted. Tasks reference their bot only through
   * these two string columns.
   */
  readonly deleteByBot: (botId: BotId) => Effect.Effect<DeleteCount, RepositoryError>;
}

export interface ActivityRepository {
  readonly create: (event: ActivityEvent) => Effect.Effect<ActivityEvent, RepositoryError>;
  readonly findAll: (options?: {
    readonly type?: string;
    readonly entityType?: string;
    readonly entityId?: string;
    readonly limit?: number;
  }) => Effect.Effect<readonly ActivityEvent[], RepositoryError>;
  /** Delete all events of an entity type for the given entity ids; returns rows deleted. */
  readonly deleteByEntityIds: (
    entityType: string,
    entityIds: readonly string[],
  ) => Effect.Effect<DeleteCount, RepositoryError>;
}

/**
 * Persistent schedules (PLAN §9): durable schedule records plus their
 * queued occurrences. Occurrences are the durable queue — they are written
 * idempotently per (scheduleId, scheduledFor) and transition to a run.
 */
export interface ScheduleRepository {
  readonly create: (schedule: Schedule) => Effect.Effect<Schedule, RepositoryError>;
  readonly findById: (id: ScheduleId) => Effect.Effect<Schedule | null, RepositoryError>;
  readonly findAll: (options?: {
    readonly botId?: BotId;
    readonly enabled?: boolean;
    readonly createdBy?: string;
    readonly conversationId?: string;
    readonly limit?: number;
  }) => Effect.Effect<readonly Schedule[], RepositoryError>;
  /** Enabled schedules with nextRunAt due (<= now). */
  readonly findDue: (now: number) => Effect.Effect<readonly Schedule[], RepositoryError>;
  readonly update: (schedule: Schedule) => Effect.Effect<Schedule, RepositoryError | NotFoundError>;
  readonly delete: (id: ScheduleId) => Effect.Effect<void, RepositoryError | NotFoundError>;
  /**
   * Insert an occurrence. Idempotent: when a row already exists for
   * (scheduleId, scheduledFor) the existing row is returned untouched.
   */
  readonly createOccurrence: (
    occurrence: ScheduleOccurrence,
  ) => Effect.Effect<ScheduleOccurrence, RepositoryError>;
  readonly findOccurrence: (
    id: ScheduleOccurrence["id"],
  ) => Effect.Effect<ScheduleOccurrence | null, RepositoryError>;
  readonly findOccurrenceByRun: (
    runId: RunId,
  ) => Effect.Effect<ScheduleOccurrence | null, RepositoryError>;
  readonly listOccurrences: (
    scheduleId: ScheduleId,
    options?: { readonly limit?: number },
  ) => Effect.Effect<readonly ScheduleOccurrence[], RepositoryError>;
  readonly findOccurrences: (options?: {
    readonly status?: ScheduleOccurrenceStatus;
    readonly limit?: number;
  }) => Effect.Effect<readonly ScheduleOccurrence[], RepositoryError>;
  readonly updateOccurrence: (
    occurrence: ScheduleOccurrence,
  ) => Effect.Effect<ScheduleOccurrence, RepositoryError | NotFoundError>;
  readonly deleteOccurrences: (scheduleId: ScheduleId) => Effect.Effect<number, RepositoryError>;
}

/** Key/value storage for app-wide mutable settings. */
export interface SettingsRepository {
  readonly get: (key: string) => Effect.Effect<string | null, RepositoryError>;
  readonly set: (key: string, value: string) => Effect.Effect<void, RepositoryError>;
}

export interface Clock {
  readonly now: () => number;
}

export interface IdGenerator {
  readonly generate: () => string;
}

export interface StoredReceivedFile {
  readonly savedName: string;
  readonly size: number;
}

export interface ReceivedFileBytes {
  readonly savedName: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export interface BotWorkspace {
  readonly root: string;
  readonly ensureHome: (botId: BotId) => Effect.Effect<string, WorkspaceError>;
  readonly writePersona: (botId: BotId, persona: string) => Effect.Effect<void, WorkspaceError>;
  readonly homePath: (botId: BotId) => string;
  /** Remove a bot's home directory (persona, notes, memory, logs) before deleting its record. */
  readonly removeHome: (botId: BotId) => Effect.Effect<void, WorkspaceError>;
  /** Save bytes under receivedFiles/<conversationId>/, uniquifying the file name. */
  readonly storeReceivedFile: (
    botId: BotId,
    conversationId: string,
    originalName: string,
    bytes: Uint8Array,
  ) => Effect.Effect<StoredReceivedFile, WorkspaceError>;
  readonly readReceivedFile: (
    botId: BotId,
    conversationId: string,
    savedName: string,
  ) => Effect.Effect<ReceivedFileBytes | null, WorkspaceError>;
  readonly removeReceivedFile: (
    botId: BotId,
    conversationId: string,
    savedName: string,
  ) => Effect.Effect<boolean, WorkspaceError>;
  /** Delete receivedFiles/<conversationId>/ for a bot (no-op when missing). */
  readonly removeReceivedConversationDir: (
    botId: BotId,
    conversationId: string,
  ) => Effect.Effect<void, WorkspaceError>;
}
