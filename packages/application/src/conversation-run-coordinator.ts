import { Cause, Effect } from "effect";
import type { Message, MessageSenderType, Run } from "@bebots/domain";
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

/**
 * Persists a completed conversation run's summary as a bot reply. Kept as its
 * own tiny collaborator so RunService can depend on this narrow interface
 * instead of the messaging service.
 */
export class BotReplyRecorder implements ConversationReplyRecorder {
  private readonly conversationService: ConversationService;

  constructor(deps: { readonly conversationService: ConversationService }) {
    this.conversationService = deps.conversationService;
  }

  recordBotReply(
    conversationId: string,
    botId: string,
    content: string,
  ): Effect.Effect<void, ValidationError | RepositoryError | ServiceError> {
    const conversationService = this.conversationService;
    return Effect.gen(function* () {
      if (content.trim().length === 0) return;
      yield* conversationService.addMessage({
        conversationId,
        content,
        senderType: "bot",
        senderId: botId,
      });
    });
  }
}

export interface SendMessageResult {
  readonly message: Message;
  /** Reply run started for the message, if any; null when not triggered or the run could not start. */
  readonly run: Run | null;
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
 * is recorded by BotReplyRecorder when RunService finalizes the run — never
 * by the coordinator itself, so any conversation run gets recorded the same
 * way.
 */
export class ConversationRunCoordinator {
  private readonly conversationService: ConversationService;
  private readonly runService: RunService;
  private readonly botRepo: BotRepository;

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
    const runService = this.runService;
    const botRepo = this.botRepo;
    return Effect.gen(function* () {
      const conversation = yield* conversationService.getConversation(input.conversationId);
      if (!conversation) {
        return yield* Effect.fail(new NotFoundError("Conversation", String(input.conversationId)));
      }
      const message = yield* conversationService.addMessage(input);
      const senderType: MessageSenderType = input.senderType ?? "human";
      if (senderType !== "human") {
        return { message, run: null };
      }

      const findFirstBotParticipant = Effect.gen(function* () {
        for (const participant of conversation.participants) {
          const raw = participant.trim();
          if (raw.length === 0) continue;
          const bot = yield* botRepo.findById(asBotId(raw));
          if (bot && bot.status === "active") return bot;
        }
        return null;
      });

      return yield* Effect.gen(function* () {
        const bot = yield* findFirstBotParticipant;
        if (!bot) return { message, run: null };
        const run = yield* runService.startRun({
          botId: bot.id,
          prompt: message.content,
          conversationId: conversation.id,
          triggerType: "message",
        });
        return { message, run };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // A reply run that cannot start never fails the delivered
            // message: log it and report `run: null`.
            yield* Effect.logError(
              "Conversation reply run failed to start",
              message.id,
              Cause.squash(cause),
            );
            return { message, run: null };
          }),
        ),
      );
    });
  }
}
