/* eslint-disable @typescript-eslint/no-this-alias */
import { Cause, Effect } from "effect";
import type { Conversation, Message, MessageSenderType, Run } from "@bebots/domain";
import {
  appendPromptNotes,
  asBotId,
  asConversationId,
  attachmentPromptNote,
  attachmentRelativePath,
  encodeAttachmentMarker,
} from "@bebots/domain";
import type { AddMessageInput } from "./conversation-service.js";
import { ConversationService } from "./conversation-service.js";
import { NotFoundError, RepositoryError, ServiceError, ValidationError, WorkspaceError } from "./errors.js";
import type { BotRepository, Clock } from "./repositories.js";
import type { RunService } from "./run-service.js";
import type { AttachmentService } from "./attachment-service.js";

export interface MessageAttachmentRef {
  readonly savedName: string;
  readonly fileName: string;
  readonly size: number;
  readonly contentType: string;
  readonly botId: string;
}

export interface SendMessageInput extends AddMessageInput {
  readonly attachments?: readonly MessageAttachmentRef[];
}

/**
 * What RunService needs when a conversation run completes: post the run's
 * answer into the thread as a bot reply (PLAN §12 M3: connect conversations
 * to agent runs without conflating their identities).
 */
export interface ConversationReplyRecorder {
  readonly recordBotReply: (
    conversationId: string,
    botId: string,
    content: string,
  ) => Effect.Effect<void, ValidationError | RepositoryError | ServiceError>;
  /** Optional: append a non-bubble system marker into the thread (ask Q&A, etc.). */
  readonly recordSystemMarker?: (
    conversationId: string,
    content: string,
  ) => Effect.Effect<void, ValidationError | RepositoryError | ServiceError>;
}

export interface SendMessageResult {
  readonly message: Message;
  /** Reply run started for the message, if any; null when not triggered or the run could not start. */
  readonly run: Run | null;
  /** All runs triggered by this message (parallel delegation support). */
  readonly runs: readonly Run[];
}

export interface ConversationRunCoordinatorDeps {
  readonly conversationService: ConversationService;
  readonly runService: RunService;
  readonly botRepo: BotRepository;
  /** Optional injected clock (bot-link pin TTLs); defaults to wall time. */
  readonly clock?: Clock;
  readonly attachmentService?: AttachmentService;
}

/**
 * Completes the reply loop between messaging and runs (PLAN §12 M3):
 * a human message in a direct conversation with an active bot participant
 * triggers a run for that bot resuming the stored session. The bot's answer
 * is recorded through `recordBotReply` (this coordinator, satisfying
 * RunService's `ConversationReplyRecorder`) when RunService finalizes the
 * run — so any conversation run gets recorded the same way.
 */
export const MAX_MESSAGE_HOP_DEPTH = 3;

/**
 * Sliding inactivity window for bot-to-bot link pins. A pin normally lives
 * until the caller bot records a reply of its own (its run answered the
 * user); the expiry only catches callers whose turn never produced a reply
 * (failed/cancelled run, crashed process).
 */
export const BOT_LINK_PIN_TTL_MS = 10 * 60 * 1000;

/**
 * One bot-to-bot link pin: the caller bot's messages to the target bot are
 * routed into `conversationId` until the pin is released or expires, so the
 * target keeps answering from the same resumable session.
 */
interface BotLinkPin {
  readonly conversationId: string;
  pinnedAt: number;
}

export class ConversationRunCoordinator implements ConversationReplyRecorder {
  private readonly conversationService: ConversationService;
  private readonly runService: RunService;
  private readonly botRepo: BotRepository;
  private readonly clock: Clock;
  private readonly attachmentService: AttachmentService | undefined;
  private readonly hopCounts = new Map<string, number>();

  /** Pins: caller bot id → target bot id → pinned (caller, target) conversation. */
  private readonly botLinks = new Map<string, Map<string, BotLinkPin>>();
  /** Conversation ids created through `resolveBotLinkConversation`. */
  private readonly botLinkConversations = new Set<string>();

  constructor(deps: ConversationRunCoordinatorDeps) {
    this.conversationService = deps.conversationService;
    this.runService = deps.runService;
    this.botRepo = deps.botRepo;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.attachmentService = deps.attachmentService;
  }

  // --- Bot-to-bot link pins (send_message continuity) ---

  /**
   * Resolve the conversation a bot-to-bot `send_message` posts into (called
   * by the MCP layer). An explicit conversation id always wins. Otherwise, a
   * (caller, target) pin that is still active and backed by an existing
   * conversation is reused (and its inactivity window slides); with no pin,
   * a fresh direct conversation is created for the pair and pinned, so every
   * further message the caller sends to this target during its current turn
   * keeps reaching the same conversation — and therefore the same resumable
   * recipient session.
   */
  resolveBotLinkConversation(input: {
    readonly callerBotId: string;
    readonly targetBotId: string;
    readonly conversationId?: string;
  }): Effect.Effect<string, RepositoryError | ServiceError> {
    const conversationService = this.conversationService;
    const self = this;
    return Effect.gen(function* () {
      if (input.conversationId && input.conversationId.trim().length > 0) {
        return input.conversationId;
      }
      self.pruneExpiredBotLinks();
      const pin = self.botLinks.get(input.callerBotId)?.get(input.targetBotId);
      if (pin) {
        const conversation = yield* conversationService.getConversation(pin.conversationId);
        if (conversation) {
          pin.pinnedAt = self.clock.now();
          return pin.conversationId;
        }
        // The conversation vanished (e.g. deleted); drop the stale pin.
        self.removeBotLink(input.callerBotId, input.targetBotId);
      }
      const conversation = yield* conversationService.createConversation({
        kind: "direct",
        participants: [input.callerBotId, input.targetBotId],
      });
      const conversationId = String(conversation.id);
      const targets = self.botLinks.get(input.callerBotId) ?? new Map<string, BotLinkPin>();
      targets.set(input.targetBotId, { conversationId, pinnedAt: self.clock.now() });
      self.botLinks.set(input.callerBotId, targets);
      self.botLinkConversations.add(conversationId);
      return conversationId;
    }) as Effect.Effect<string, RepositoryError | ServiceError>;
  }

  /**
   * Release caller bot's link pins: the caller recorded a reply of its own,
   * which is how a bot "responds back to the user" — its turn is over and
   * later messages to previous targets start fresh conversations/sessions.
   */
  private releaseBotLinks(callerBotId: string): void {
    const targets = this.botLinks.get(callerBotId);
    if (!targets) return;
    for (const targetId of [...targets.keys()]) {
      const pin = targets.get(targetId);
      if (pin) this.botLinkConversations.delete(pin.conversationId);
      targets.delete(targetId);
    }
    this.botLinks.delete(callerBotId);
  }

  private removeBotLink(callerBotId: string, targetBotId: string): void {
    const targets = this.botLinks.get(callerBotId);
    if (!targets) return;
    const pin = targets.get(targetBotId);
    if (pin) this.botLinkConversations.delete(pin.conversationId);
    targets.delete(targetBotId);
    if (targets.size === 0) this.botLinks.delete(callerBotId);
  }

  /** Safety net: drop pins whose sliding inactivity window has elapsed. */
  private pruneExpiredBotLinks(): void {
    const now = this.clock.now();
    for (const [callerId, targets] of this.botLinks) {
      for (const [targetId, pin] of [...targets]) {
        if (now - pin.pinnedAt > BOT_LINK_PIN_TTL_MS) {
          this.botLinkConversations.delete(pin.conversationId);
          targets.delete(targetId);
        }
      }
      if (targets.size === 0) this.botLinks.delete(callerId);
    }
  }

  /**
   * True when `senderBotId` was contacted by `callerBotId` through a pinned
   * bot-link conversation: the caller already receives the target's replies
   * synchronously (send_message awaits the run), so propagating the reply
   * back would only re-trigger the caller redundantly.
   */
  private suppressBotLinkCaller(
    callerBotId: string,
    senderBotId: string,
    conversationId: string,
  ): boolean {
    const pin = this.botLinks.get(callerBotId)?.get(senderBotId);
    return pin !== undefined && pin.conversationId === conversationId;
  }

  /**
   * Persist the message and, for human messages, trigger the participant
   * bot's reply run. Only human messages trigger (loop prevention at the
   * only seam M3 has; bot-to-bot and mention triggers arrive in M4). A
   * run-start failure never fails delivering the message: it is logged and
   * surfaced as `run: null`.
   */
  sendMessage(
    input: SendMessageInput,
  ): Effect.Effect<
    SendMessageResult,
    NotFoundError | ValidationError | RepositoryError | ServiceError | WorkspaceError
  > {
    const conversationService = this.conversationService;
    const self = this;
    return Effect.gen(function* () {
      const conversation = yield* conversationService.getConversation(input.conversationId);
      if (!conversation) {
        return yield* Effect.fail(new NotFoundError("Conversation", String(input.conversationId)));
      }
      const attachments = input.attachments ?? [];
      const content = (input.content ?? "").toString();
      if (content.trim().length === 0 && attachments.length === 0) {
        return yield* Effect.fail(
          new ValidationError("content", "Message content cannot be empty"),
        );
      }
      const message = yield* conversationService.addMessage({
        ...input,
        content,
        allowEmpty: attachments.length > 0,
      });
      const senderType: MessageSenderType = input.senderType ?? "human";
      const senderId = input.senderId ? String(input.senderId) : null;

      const noteLines: string[] = [];
      for (const attachment of attachments) {
        const relativePath = attachmentRelativePath(
          String(conversation.id),
          attachment.savedName,
        );
        noteLines.push(attachmentPromptNote(relativePath));
        yield* self.recordSystemMarker(
          String(conversation.id),
          encodeAttachmentMarker({
            fileName: attachment.fileName,
            savedName: attachment.savedName,
            relativePath,
            size: attachment.size,
            contentType: attachment.contentType,
            botId: attachment.botId,
            conversationId: String(conversation.id),
          }),
        );
      }

      const promptOverride =
        noteLines.length > 0 ? appendPromptNotes(message.content, noteLines) : undefined;

      const runs = yield* self.processPersistedMessage(
        conversation,
        message,
        senderType,
        senderId,
        promptOverride,
      );

      return { message, run: runs[0] ?? null, runs };
    }) as Effect.Effect<
      SendMessageResult,
      NotFoundError | ValidationError | RepositoryError | ServiceError | WorkspaceError
    >;
  }

  /**
   * Resolve recipients for an already-persisted message and trigger their runs.
   * Shared by `sendMessage` and bot-reply mention handling.
   */
  processPersistedMessage(
    conversation: Conversation,
    message: Message,
    senderType: MessageSenderType,
    senderId: string | null,
    promptOverride?: string,
  ): Effect.Effect<
    readonly Run[],
    NotFoundError | ValidationError | RepositoryError | ServiceError
  > {
    const runService = this.runService;
    const botRepo = this.botRepo;
    const self = this;
    return Effect.gen(function* () {
      // Loop prevention: bot-triggered messages only propagate up to
      // MAX_MESSAGE_HOP_DEPTH hops.
      let currentHops = self.hopCounts.get(String(conversation.id)) ?? 0;
      if (senderType === "human") {
        currentHops = 0;
        // A human message means bots are being prompted again; this is also
        // the cheapest place to sweep expired bot-link pins as a safety net.
        self.pruneExpiredBotLinks();
      }
      const canPropagate = senderType !== "system" && currentHops < MAX_MESSAGE_HOP_DEPTH;

      // Resolve recipient bots.
      const recipients = new Map<string, { id: string; name: string }>();

      // Explicit mentions (@botId or @botName) resolve recipients for bot
      // senders only (bot-to-bot relay, PLAN §12 M4): a bot may address a
      // specific peer inside a thread. A human message always stays with the
      // participant bot the user is talking to — that bot contacts the
      // @-mentioned peer itself via send_message. Redirecting a human
      // mention to the peer started a second run and delivered the reply
      // twice (see "duplicate reply runs" tests).
      if (senderType !== "human") {
        const mentionTokens = [...(message.content.match(/@([A-Za-z0-9_-]+)/g) ?? [])].map((t) =>
          t.slice(1),
        );
        for (const token of mentionTokens) {
          // Try by id first.
          let bot = yield* botRepo
            .findById(asBotId(token))
            .pipe(Effect.catchCause((_cause) => Effect.succeed(null)));
          if (!bot) {
            // Try by name.
            const all = yield* botRepo.findAll();
            bot = all.find((b) => b.name === token && b.status === "active") ?? null;
          }
          if (bot && bot.status === "active" && String(bot.id) !== senderId) {
            // In a bot-link conversation the pinned caller receives the
            // target's replies synchronously via send_message; do not
            // re-trigger it.
            if (
              senderId &&
              self.suppressBotLinkCaller(String(bot.id), senderId, String(conversation.id))
            ) {
              continue;
            }
            recipients.set(String(bot.id), { id: String(bot.id), name: bot.name });
          }
        }
      }

      // Human messages trigger the first active bot participant (M3
      // behavior) — mentions never redirect a human message away from the
      // participant bot they are talking to.
      if (senderType === "human" && canPropagate) {
        for (const participant of conversation.participants) {
          const raw = participant.trim();
          if (raw.length === 0) continue;
          const bot = yield* botRepo
            .findById(asBotId(raw))
            .pipe(Effect.catchCause((_cause) => Effect.succeed(null)));
          if (bot && bot.status === "active") {
            recipients.set(String(bot.id), { id: String(bot.id), name: bot.name });
            break; // only first, matching M3
          }
        }
      }

      // Bot messages trigger all OTHER active bot participants (bot-to-bot).
      if (senderType === "bot" && senderId && canPropagate) {
        for (const participant of conversation.participants) {
          const raw = participant.trim();
          if (raw.length === 0) continue;
          const bot = yield* botRepo
            .findById(asBotId(raw))
            .pipe(Effect.catchCause((_cause) => Effect.succeed(null)));
          if (bot && bot.status === "active" && String(bot.id) !== senderId) {
            if (self.suppressBotLinkCaller(String(bot.id), senderId, String(conversation.id))) {
              continue;
            }
            recipients.set(String(bot.id), { id: String(bot.id), name: bot.name });
          }
        }
      }

      if (recipients.size === 0 || !canPropagate) {
        return [] as readonly Run[];
      }

      // Hop bookkeeping.
      self.hopCounts.set(String(conversation.id), currentHops + 1);

      const recipientList = [...recipients.values()];
      const prompt = promptOverride ?? message.content;
      // File-only human sends use an empty message body; the prompt is the
      // attachment footnotes. Skip starting a run when there is still nothing
      // for the model to see.
      if (prompt.trim().length === 0) {
        return [] as readonly Run[];
      }
      const startOne = (recipient: { id: string; name: string }) =>
        runService
          .startRun({
            botId: asBotId(recipient.id),
            prompt,
            conversationId: conversation.id,
            triggerType: "message",
            // Bot-to-bot conversation runs resume the recipient's
            // per-conversation session like every other conversation run
            // (send_message continuity); the session store already scopes
            // sessions per (conversation, bot).
          })
          .pipe(
            Effect.catchCause((cause) => {
              void Effect.runPromise(
                Effect.logError(
                  "Conversation reply run failed to start",
                  message.id,
                  Cause.squash(cause),
                ),
              );
              return Effect.succeed(null as Run | null);
            }),
          );

      const runs = (yield* Effect.all(recipientList.map(startOne), {
        concurrency: "unbounded",
      })).filter((r): r is Run => r !== null);

      return runs as readonly Run[];
    }) as Effect.Effect<
      readonly Run[],
      NotFoundError | ValidationError | RepositoryError | ServiceError
    >;
  }

  /**
   * Posts a completed run's summary into the thread as a bot reply and lets
   * it propagate (mention relay, hop bookkeeping) like any persisted bot
   * message. Satisfies RunService's `ConversationReplyRecorder` directly —
   * no separate adapter class or mutable trigger wiring.
   */
  recordBotReply(
    conversationId: string,
    botId: string,
    content: string,
  ): Effect.Effect<void, ValidationError | RepositoryError | ServiceError> {
    const conversationService = this.conversationService;
    const self = this;
    return Effect.gen(function* () {
      if (content.trim().length === 0) return;
      // The conversation may have been deleted while the run was in flight;
      // posting into it would resurrect orphaned rows for a deleted thread.
      const conversation = yield* conversationService.getConversation(conversationId);
      if (!conversation) return;
      const message = yield* conversationService.addMessage({
        conversationId,
        content,
        senderType: "bot",
        senderId: botId,
      });
      // A bot recording its own reply is how it "responds back to the user";
      // its turn is over, so release the bot-link pins it created during this
      // turn (later sends to those targets start fresh again).
      self.releaseBotLinks(botId);
      // Propagation failures are ignored: the reply itself is already stored,
      // and delivery must not depend on the relay hop.
      yield* self.triggerForMessage(conversationId, message, "bot", botId).pipe(Effect.ignore);
    });
  }

  recordSystemMarker(
    conversationId: string,
    content: string,
  ): Effect.Effect<void, ValidationError | RepositoryError | ServiceError> {
    const conversationService = this.conversationService;
    return Effect.gen(function* () {
      if (content.trim().length === 0) return;
      const conversation = yield* conversationService.getConversation(conversationId);
      if (!conversation) return;
      yield* conversationService.addMessage({
        conversationId,
        content,
        senderType: "system",
      });
    });
  }

  /**
   * Delete a conversation as a unit: stop any queued/running runs bound to it
   * (they would otherwise post replies or rotate session rows for a thread
   * that no longer exists), purge its run rows + events, purge messages and
   * session records via the conversation service, then clean in-memory state
   * that references the conversation (hop counters, bot-link pins). The
   * conversation row itself is deleted last, so a mid-cascade failure leaves
   * the thread addressable and the DELETE retryable. Fails NotFound when the
   * conversation does not exist.
   */
  deleteConversation(
    conversationId: string,
  ): Effect.Effect<void, NotFoundError | RepositoryError | ServiceError | WorkspaceError> {
    const runService = this.runService;
    const conversationService = this.conversationService;
    const attachmentService = this.attachmentService;
    const self = this;
    return Effect.gen(function* () {
      const id = asConversationId(conversationId);
      const existing = yield* conversationService.getConversation(conversationId);
      yield* runService
        .cancelRunsForConversation(id)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError(
              "Cancelling conversation runs before delete failed",
              conversationId,
              Cause.squash(cause),
            ),
          ),
        );
      // Run rows and their events are part of the thread's history; children
      // of the conversation go before the conversation row itself.
      yield* runService.deleteRunsForConversation(id);
      if (attachmentService && existing) {
        yield* attachmentService
          .removeConversationFiles(conversationId, existing.participants)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError(
                "Removing conversation attachments before delete failed",
                conversationId,
                Cause.squash(cause),
              ),
            ),
          );
      }
      yield* conversationService.deleteConversation(conversationId);
      // In-memory bookkeeping: hop counts and any bot-link pins targeting
      // this conversation must not survive it.
      self.hopCounts.delete(conversationId);
      for (const [callerId, targets] of self.botLinks) {
        for (const [targetId, pin] of [...targets]) {
          if (pin.conversationId === conversationId) {
            targets.delete(targetId);
          }
        }
        if (targets.size === 0) self.botLinks.delete(callerId);
      }
      self.botLinkConversations.delete(conversationId);
    }) as Effect.Effect<void, NotFoundError | RepositoryError | ServiceError | WorkspaceError>;
  }

  /** Trigger recipients for an already-persisted message (used by bot replies). */
  triggerForMessage(
    conversationId: string,
    message: Message,
    senderType: MessageSenderType,
    senderId: string | null,
  ): Effect.Effect<void, NotFoundError | ValidationError | RepositoryError | ServiceError> {
    const conversationService = this.conversationService;
    const self = this;
    return Effect.gen(function* () {
      const conversation = yield* conversationService.getConversation(conversationId);
      if (!conversation) return;
      yield* self.processPersistedMessage(conversation, message, senderType, senderId);
    });
  }
}
