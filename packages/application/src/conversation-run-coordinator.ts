/* eslint-disable @typescript-eslint/no-this-alias */
import { Cause, Effect } from "effect";
import type { Conversation, Message, MessageSenderType, Run } from "@bebots/domain";
import { asBotId } from "@bebots/domain";
import type { AddMessageInput } from "./conversation-service.js";
import { ConversationService } from "./conversation-service.js";
import { NotFoundError, RepositoryError, ServiceError, ValidationError } from "./errors.js";
import type { BotRepository } from "./repositories.js";
import type { RunService } from "./run-service.js";

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

export class ConversationRunCoordinator implements ConversationReplyRecorder {
  private readonly conversationService: ConversationService;
  private readonly runService: RunService;
  private readonly botRepo: BotRepository;
  private readonly hopCounts = new Map<string, number>();

  constructor(deps: ConversationRunCoordinatorDeps) {
    this.conversationService = deps.conversationService;
    this.runService = deps.runService;
    this.botRepo = deps.botRepo;
  }

  /**
   * Persist the message and, for human messages, trigger the participant
   * bot's reply run. Only human messages trigger (loop prevention at the
   * only seam M3 has; bot-to-bot and mention triggers arrive in M4). A
   * run-start failure never fails delivering the message: it is logged and
   * surfaced as `run: null`.
   */
  sendMessage(
    input: AddMessageInput,
  ): Effect.Effect<
    SendMessageResult,
    NotFoundError | ValidationError | RepositoryError | ServiceError
  > {
    const conversationService = this.conversationService;
    const self = this;
    return Effect.gen(function* () {
      const conversation = yield* conversationService.getConversation(input.conversationId);
      if (!conversation) {
        return yield* Effect.fail(new NotFoundError("Conversation", String(input.conversationId)));
      }
      const message = yield* conversationService.addMessage(input);
      const senderType: MessageSenderType = input.senderType ?? "human";
      const senderId = input.senderId ? String(input.senderId) : null;

      const runs = yield* self.processPersistedMessage(conversation, message, senderType, senderId);

      return { message, run: runs[0] ?? null, runs };
    }) as Effect.Effect<SendMessageResult, NotFoundError | ValidationError | RepositoryError | ServiceError>;
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
  ): Effect.Effect<readonly Run[], NotFoundError | ValidationError | RepositoryError | ServiceError> {
    const runService = this.runService;
    const botRepo = this.botRepo;
    const self = this;
    return Effect.gen(function* () {
      // Loop prevention: bot-triggered messages only propagate up to
      // MAX_MESSAGE_HOP_DEPTH hops.
      let currentHops = self.hopCounts.get(String(conversation.id)) ?? 0;
      if (senderType === "human") currentHops = 0;
      const canPropagate =
        senderType !== "system" && currentHops < MAX_MESSAGE_HOP_DEPTH;

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
          const bot = yield* botRepo.findById(asBotId(raw)).pipe(Effect.catchCause((_cause) => Effect.succeed(null)));
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
          const bot = yield* botRepo.findById(asBotId(raw)).pipe(Effect.catchCause((_cause) => Effect.succeed(null)));
          if (bot && bot.status === "active" && String(bot.id) !== senderId) {
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
      const startOne = (recipient: { id: string; name: string }) =>
        runService
          .startRun({
            botId: asBotId(recipient.id),
            prompt: message.content,
            conversationId: conversation.id,
            triggerType: "message",
            newSession: senderType === "bot",
          })
          .pipe(
            Effect.catchCause((cause) => {
              void Effect.runPromise(
                Effect.logError("Conversation reply run failed to start", message.id, Cause.squash(cause)),
              );
              return Effect.succeed(null as Run | null);
            }),
          );

      const runs = (yield* Effect.all(recipientList.map(startOne), { concurrency: "unbounded" })).filter(
        (r): r is Run => r !== null,
      );

      return runs as readonly Run[];
    }) as Effect.Effect<readonly Run[], NotFoundError | ValidationError | RepositoryError | ServiceError>;
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
      const message = yield* conversationService.addMessage({
        conversationId,
        content,
        senderType: "bot",
        senderId: botId,
      });
      // Propagation failures are ignored: the reply itself is already stored,
      // and delivery must not depend on the relay hop.
      yield* self
        .triggerForMessage(conversationId, message, "bot", botId)
        .pipe(Effect.ignore);
    });
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
