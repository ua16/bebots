import { Effect } from "effect";
import {
  asBotId,
  asConversationId,
  attachmentRelativePath,
  MAX_ATTACHMENT_BYTES,
  sanitizeAttachmentFileName,
} from "@bebots/domain";
import type { BotId } from "@bebots/domain";
import type { BotRepository, BotWorkspace } from "./repositories.js";
import { NotFoundError, RepositoryError, ValidationError, WorkspaceError } from "./errors.js";
import type { ConversationService } from "./conversation-service.js";

export interface StoredAttachment {
  readonly botId: string;
  readonly conversationId: string;
  readonly fileName: string;
  readonly savedName: string;
  readonly relativePath: string;
  readonly size: number;
  readonly contentType: string;
}

export interface AttachmentBytes {
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export interface AttachmentServiceDeps {
  readonly workspace: BotWorkspace;
  readonly conversationService: ConversationService;
  readonly botRepo: BotRepository;
}

export class AttachmentService {
  private readonly workspace: BotWorkspace;
  private readonly conversationService: ConversationService;
  private readonly botRepo: BotRepository;

  constructor(deps: AttachmentServiceDeps) {
    this.workspace = deps.workspace;
    this.conversationService = deps.conversationService;
    this.botRepo = deps.botRepo;
  }

  resolveRecipientBotId(
    conversationId: string,
  ): Effect.Effect<BotId, NotFoundError | ValidationError | RepositoryError> {
    const conversationService = this.conversationService;
    const botRepo = this.botRepo;
    return Effect.gen(function* () {
      const conversation = yield* conversationService.getConversation(conversationId);
      if (!conversation) {
        return yield* Effect.fail(new NotFoundError("Conversation", conversationId));
      }
      for (const participant of conversation.participants) {
        const raw = participant.trim();
        if (raw.length === 0) continue;
        const bot = yield* botRepo
          .findById(asBotId(raw))
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (bot && bot.status === "active") {
          return bot.id;
        }
      }
      return yield* Effect.fail(
        new ValidationError("conversationId", "Conversation has no active bot participant"),
      );
    });
  }

  storeUpload(input: {
    readonly conversationId: string;
    readonly originalName: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Effect.Effect<
    StoredAttachment,
    NotFoundError | ValidationError | WorkspaceError | RepositoryError
  > {
    const workspace = this.workspace;
    const self = this;
    return Effect.gen(function* () {
      const conversationId = String(asConversationId(input.conversationId));
      if (
        conversationId.includes("/") ||
        conversationId.includes("\\") ||
        conversationId.includes("\0")
      ) {
        return yield* Effect.fail(new ValidationError("conversationId", "Unsafe conversationId"));
      }
      if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        return yield* Effect.fail(
          new ValidationError("file", `File exceeds ${MAX_ATTACHMENT_BYTES} byte limit`),
        );
      }
      const botId = yield* self.resolveRecipientBotId(conversationId);
      yield* workspace.ensureHome(botId);
      const stored = yield* workspace.storeReceivedFile(
        botId,
        conversationId,
        input.originalName,
        input.bytes,
      );
      const fileName = sanitizeAttachmentFileName(input.originalName);
      const result: StoredAttachment = {
        botId: String(botId),
        conversationId,
        fileName,
        savedName: stored.savedName,
        relativePath: attachmentRelativePath(conversationId, stored.savedName),
        size: stored.size,
        contentType: input.contentType.trim() || "application/octet-stream",
      };
      return result;
    });
  }

  readAttachment(input: {
    readonly conversationId: string;
    readonly botId: string;
    readonly savedName: string;
  }): Effect.Effect<AttachmentBytes, NotFoundError | ValidationError | WorkspaceError> {
    const workspace = this.workspace;
    return Effect.gen(function* () {
      const conversationId = String(asConversationId(input.conversationId));
      const savedName = sanitizeAttachmentFileName(input.savedName);
      if (savedName !== input.savedName || savedName.includes("/") || savedName.includes("\\")) {
        return yield* Effect.fail(new ValidationError("savedName", "Unsafe savedName"));
      }
      const botId = asBotId(input.botId);
      const file = yield* workspace.readReceivedFile(botId, conversationId, savedName);
      if (!file) {
        return yield* Effect.fail(new NotFoundError("Attachment", savedName));
      }
      const result: AttachmentBytes = {
        fileName: file.savedName,
        contentType: "application/octet-stream",
        size: file.size,
        bytes: file.bytes,
      };
      return result;
    });
  }

  deleteAttachment(input: {
    readonly conversationId: string;
    readonly botId: string;
    readonly savedName: string;
  }): Effect.Effect<void, NotFoundError | ValidationError | WorkspaceError> {
    const workspace = this.workspace;
    return Effect.gen(function* () {
      const conversationId = String(asConversationId(input.conversationId));
      const savedName = sanitizeAttachmentFileName(input.savedName);
      if (savedName !== input.savedName || savedName.includes("/") || savedName.includes("\\")) {
        return yield* Effect.fail(new ValidationError("savedName", "Unsafe savedName"));
      }
      const botId = asBotId(input.botId);
      const removed = yield* workspace.removeReceivedFile(botId, conversationId, savedName);
      if (!removed) {
        return yield* Effect.fail(new NotFoundError("Attachment", savedName));
      }
    });
  }

  removeConversationFiles(
    conversationId: string,
    participantIds: readonly string[],
  ): Effect.Effect<void> {
    const workspace = this.workspace;
    return Effect.gen(function* () {
      const safeId = String(asConversationId(conversationId));
      for (const raw of participantIds) {
        const id = raw.trim();
        if (id.length === 0) continue;
        yield* workspace
          .removeReceivedConversationDir(asBotId(id), safeId)
          .pipe(Effect.catchCause(() => Effect.void));
      }
    });
  }
}
