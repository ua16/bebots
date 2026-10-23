import { Effect } from "effect";
import type {
  Conversation,
  ConversationKind,
  ConversationSession,
  ConversationSessionStatus,
  DeliveryState,
  Message,
  MessageId,
  MessageSenderType,
} from "@bebots/domain";
import { asConversationId, asMessageId, asConversationSessionId } from "@bebots/domain";
import type {
  ConversationRepository,
  MessageRepository,
  ConversationSessionRepository,
  Clock,
  IdGenerator,
} from "./repositories.js";
import { NotFoundError, RepositoryError, ServiceError, ValidationError } from "./errors.js";

/** Sessions older than this are expired (PLAN §5: 30 days of inactivity). */
export const CONVERSATION_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreateConversationInput {
  readonly kind?: ConversationKind;
  readonly title?: string;
  readonly participants?: readonly string[];
}

export interface UpdateConversationInput {
  readonly kind?: ConversationKind;
  readonly title?: string;
  readonly participants?: readonly string[];
}

export interface AddMessageInput {
  readonly conversationId: string;
  readonly content: string;
  readonly senderType?: MessageSenderType;
  readonly senderId?: string | null;
  readonly replyTo?: MessageId;
  readonly threadId?: string;
  readonly deliveryState?: DeliveryState;
}

export interface ListMessagesOptions {
  readonly limit?: number;
  readonly before?: number;
}

export interface CreateSessionInput {
  readonly conversationId: string;
  readonly runtimeSessionId: string;
  /** The bot whose runtime session this record mirrors (per-bot scoping). */
  readonly botId?: string | null;
  readonly status?: ConversationSessionStatus;
}

export interface ConversationServiceDeps {
  readonly conversationRepo: ConversationRepository;
  readonly messageRepo?: MessageRepository;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

/** Owns conversation records and message persistence (PLAN §5: messaging service). */
export class ConversationService {
  private readonly conversationRepo: ConversationRepository;
  private readonly messageRepo: MessageRepository | null;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(deps: ConversationServiceDeps) {
    this.conversationRepo = deps.conversationRepo;
    this.messageRepo = deps.messageRepo ?? null;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.ids = deps.ids ?? { generate: () => crypto.randomUUID() };
  }

  // --- Conversations ---

  createConversation(
    input: CreateConversationInput = {},
  ): Effect.Effect<Conversation, ValidationError | RepositoryError> {
    const conversationRepo = this.conversationRepo;
    const clock = this.clock;
    const ids = this.ids;
    return Effect.gen(function* () {
      const kind = input.kind ?? "direct";
      if (kind !== "direct" && kind !== "team") {
        return yield* Effect.fail(new ValidationError("kind", "Unknown conversation kind"));
      }
      const conversation: Conversation = {
        id: asConversationId(ids.generate()),
        kind,
        title: input.title ?? "",
        participants: (input.participants ?? []).map((p) => String(p)),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      };
      return yield* conversationRepo.create(conversation);
    });
  }

  getConversation(id: string): Effect.Effect<Conversation | null, RepositoryError> {
    return this.conversationRepo.findById(asConversationId(id));
  }

  listConversations(options?: {
    readonly kind?: ConversationKind;
    readonly participant?: string;
    readonly limit?: number;
  }): Effect.Effect<readonly Conversation[], RepositoryError> {
    return this.conversationRepo.findAll(options);
  }

  updateConversation(
    id: string,
    input: UpdateConversationInput,
  ): Effect.Effect<Conversation, RepositoryError | NotFoundError> {
    const conversationRepo = this.conversationRepo;
    const clock = this.clock;
    return Effect.gen(function* () {
      const existing = yield* conversationRepo.findById(asConversationId(id));
      if (!existing) return yield* Effect.fail(new NotFoundError("Conversation", id));
      const updated: Conversation = {
        ...existing,
        kind: input.kind ?? existing.kind,
        title: input.title !== undefined ? input.title : existing.title,
        participants:
          input.participants !== undefined
            ? input.participants.map((p) => String(p))
            : existing.participants,
        updatedAt: clock.now(),
      };
      return yield* conversationRepo.update(updated);
    });
  }

  deleteConversation(id: string): Effect.Effect<void, RepositoryError | NotFoundError> {
    return this.conversationRepo.delete(asConversationId(id));
  }

  // --- Messages ---

  addMessage(
    input: AddMessageInput,
  ): Effect.Effect<Message, ValidationError | RepositoryError | ServiceError> {
    const messageRepo = this.messageRepo;
    const clock = this.clock;
    const ids = this.ids;
    return Effect.gen(function* () {
      if (!messageRepo) {
        return yield* Effect.fail(
          new ServiceError("Messaging requires a MessageRepository (built without one)"),
        );
      }
      const content = (input.content ?? "").toString();
      if (content.trim().length === 0) {
        return yield* Effect.fail(
          new ValidationError("content", "Message content cannot be empty"),
        );
      }
      const message: Message = {
        id: asMessageId(ids.generate()),
        conversationId: asConversationId(input.conversationId),
        senderType: input.senderType ?? "human",
        senderId: input.senderId ?? null,
        content,
        ...(input.replyTo !== undefined && { replyTo: input.replyTo }),
        ...(input.threadId !== undefined && { threadId: input.threadId }),
        deliveryState: input.deliveryState ?? "delivered",
        createdAt: clock.now(),
      };
      return yield* messageRepo.create(message);
    });
  }

  listMessages(
    conversationId: string,
    options?: ListMessagesOptions,
  ): Effect.Effect<readonly Message[], RepositoryError | ServiceError> {
    const messageRepo = this.messageRepo;
    return Effect.gen(function* () {
      if (!messageRepo) {
        return yield* Effect.fail(
          new ServiceError("Messaging requires a MessageRepository (built without one)"),
        );
      }
      return yield* messageRepo.findByConversation(asConversationId(conversationId), options);
    });
  }

  getMessage(id: string): Effect.Effect<Message | null, RepositoryError | ServiceError> {
    const messageRepo = this.messageRepo;
    return Effect.gen(function* () {
      if (!messageRepo) {
        return yield* Effect.fail(
          new ServiceError("Messaging requires a MessageRepository (built without one)"),
        );
      }
      return yield* messageRepo.findById(asMessageId(id));
    });
  }
}

export interface ConversationSessionServiceDeps {
  readonly sessionRepo: ConversationSessionRepository;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

/** Operations RunService needs to resume and rotate stored sessions (PLAN §6.4). */
export interface ConversationSessionOps {
  readonly getSession: (id: string) => Effect.Effect<ConversationSession | null, RepositoryError>;
  readonly findResumableSession: (
    conversationId: string,
    botId?: string | null,
  ) => Effect.Effect<ConversationSession | null, RepositoryError>;
  readonly touchSession: (
    id: string,
  ) => Effect.Effect<ConversationSession | null, RepositoryError | NotFoundError>;
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<ConversationSession, ValidationError | RepositoryError>;
  readonly replaceRuntimeSession: (
    id: string,
    runtimeSessionId: string,
  ) => Effect.Effect<ConversationSession, RepositoryError | NotFoundError>;
}

/** Owns resumable OpenCode session ids and their lifecycle (PLAN §5). */
export class ConversationSessionService implements ConversationSessionOps {
  private readonly sessionRepo: ConversationSessionRepository;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(deps: ConversationSessionServiceDeps) {
    this.sessionRepo = deps.sessionRepo;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.ids = deps.ids ?? { generate: () => crypto.randomUUID() };
  }

  createSession(
    input: CreateSessionInput,
  ): Effect.Effect<ConversationSession, ValidationError | RepositoryError> {
    const sessionRepo = this.sessionRepo;
    const clock = this.clock;
    const ids = this.ids;
    const runtimeSessionId = (input.runtimeSessionId ?? "").trim();
    return Effect.gen(function* () {
      if (runtimeSessionId.length === 0) {
        return yield* Effect.fail(
          new ValidationError("runtimeSessionId", "Runtime session id is required"),
        );
      }
      const now = clock.now();
      const session: ConversationSession = {
        id: asConversationSessionId(ids.generate()),
        conversationId: asConversationId(input.conversationId),
        runtimeSessionId,
        botId: input.botId ?? null,
        lastUsedAt: now,
        status: input.status ?? "active",
        createdAt: now,
        updatedAt: now,
      };
      return yield* sessionRepo.create(session);
    });
  }

  getSession(id: string): Effect.Effect<ConversationSession | null, RepositoryError> {
    return this.sessionRepo.findById(asConversationSessionId(id));
  }

  listSessions(options?: {
    readonly conversationId?: string;
    readonly status?: ConversationSessionStatus;
    readonly limit?: number;
  }): Effect.Effect<readonly ConversationSession[], RepositoryError> {
    const sessionRepo = this.sessionRepo;
    return Effect.gen(function* () {
      const filtered = yield* sessionRepo.findAll({
        ...(options?.conversationId !== undefined && {
          conversationId: asConversationId(options.conversationId),
        }),
        ...(options?.status !== undefined && { status: options.status }),
      });
      return options?.limit !== undefined ? filtered.slice(0, options.limit) : filtered;
    });
  }

  /** Most recent still-active session for the conversation that belongs to
   * the given bot (per-bot scoping); expired/closed ones are not resumable.
   * Without a botId, legacy behavior: latest active session regardless of bot.
   */
  findResumableSession(
    conversationId: string,
    botId?: string | null,
  ): Effect.Effect<ConversationSession | null, RepositoryError> {
    return this.sessionRepo.findLatestByConversation(asConversationId(conversationId), {
      status: "active",
      ...(botId !== undefined && { botId }),
    });
  }

  touchSession(
    id: string,
  ): Effect.Effect<ConversationSession | null, RepositoryError | NotFoundError> {
    const sessionRepo = this.sessionRepo;
    const clock = this.clock;
    const sessionId = asConversationSessionId(id);
    return Effect.gen(function* () {
      const existing = yield* sessionRepo.findById(sessionId);
      if (!existing) return yield* Effect.fail(new NotFoundError("ConversationSession", id));
      const now = clock.now();
      return yield* sessionRepo.update({
        ...existing,
        lastUsedAt: now,
        updatedAt: now,
      });
    });
  }

  /** Transparent rotation: on expiry/failure the runtime started a new session; record it. */
  replaceRuntimeSession(
    id: string,
    runtimeSessionId: string,
  ): Effect.Effect<ConversationSession, RepositoryError | NotFoundError> {
    const sessionRepo = this.sessionRepo;
    const clock = this.clock;
    const sessionId = asConversationSessionId(id);
    return Effect.gen(function* () {
      const existing = yield* sessionRepo.findById(sessionId);
      if (!existing) return yield* Effect.fail(new NotFoundError("ConversationSession", id));
      const now = clock.now();
      return yield* sessionRepo.update({
        ...existing,
        runtimeSessionId,
        lastUsedAt: now,
        status: "active",
        updatedAt: now,
      });
    });
  }

  /** Sweep sessions idle for longer than `maxAgeMs` (default 30 days) to `expired`. */
  expireStaleSessions(
    maxAgeMs: number = CONVERSATION_SESSION_MAX_AGE_MS,
  ): Effect.Effect<readonly ConversationSession[], RepositoryError | NotFoundError> {
    const sessionRepo = this.sessionRepo;
    const clock = this.clock;
    return Effect.gen(function* () {
      const all = yield* sessionRepo.findAll({ status: "active" });
      const now = clock.now();
      const expired: ConversationSession[] = [];
      for (const session of all) {
        if (now - session.lastUsedAt <= maxAgeMs) continue;
        const updated = yield* sessionRepo.update({
          ...session,
          status: "expired",
          updatedAt: now,
        });
        expired.push(updated);
      }
      return expired;
    });
  }
}
