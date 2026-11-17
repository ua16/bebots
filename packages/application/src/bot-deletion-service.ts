import { Effect } from "effect";
import type { BotId, ConversationId } from "@bebots/domain";
import { asActivityId } from "@bebots/domain";
import type {
  ActivityRepository,
  BotRepository,
  BotWorkspace,
  Clock,
  ConversationRepository,
  ConversationSessionRepository,
  FileIndexRepository,
  IdGenerator,
  RunRepository,
  TaskRepository,
} from "./repositories.js";
import { NotFoundError, RepositoryError, WorkspaceError } from "./errors.js";
import type { RunService } from "./run-service.js";
import type { ScheduleService } from "./schedule-service.js";
import type { ConversationRunCoordinator } from "./conversation-run-coordinator.js";

export interface BotDeletionServiceDeps {
  readonly botRepo: BotRepository;

  readonly conversationRepo: ConversationRepository;
  readonly runRepo: RunRepository;

  readonly sessionRepo: ConversationSessionRepository;
  readonly taskRepo: TaskRepository;
  readonly fileIndex: FileIndexRepository;
  readonly activity: ActivityRepository;
  readonly workspace: BotWorkspace;

  readonly runService: RunService;

  readonly scheduleService: ScheduleService;

  readonly coordinator: ConversationRunCoordinator;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class BotDeletionService {
  private readonly botRepo: BotRepository;
  private readonly conversationRepo: ConversationRepository;
  private readonly runRepo: RunRepository;
  private readonly sessionRepo: ConversationSessionRepository;
  private readonly taskRepo: TaskRepository;
  private readonly fileIndex: FileIndexRepository;
  private readonly activity: ActivityRepository;
  private readonly workspace: BotWorkspace;
  private readonly runService: RunService;
  private readonly scheduleService: ScheduleService;
  private readonly coordinator: ConversationRunCoordinator;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(deps: BotDeletionServiceDeps) {
    this.botRepo = deps.botRepo;
    this.conversationRepo = deps.conversationRepo;
    this.runRepo = deps.runRepo;
    this.sessionRepo = deps.sessionRepo;
    this.taskRepo = deps.taskRepo;
    this.fileIndex = deps.fileIndex;
    this.activity = deps.activity;
    this.workspace = deps.workspace;
    this.runService = deps.runService;
    this.scheduleService = deps.scheduleService;
    this.coordinator = deps.coordinator;
    this.clock = deps.clock;
    this.ids = deps.ids;
  }

  deleteBot(id: BotId): Effect.Effect<void, NotFoundError | RepositoryError | WorkspaceError> {
    const botRepo = this.botRepo;
    const conversationRepo = this.conversationRepo;
    const runRepo = this.runRepo;
    const sessionRepo = this.sessionRepo;
    const taskRepo = this.taskRepo;
    const fileIndex = this.fileIndex;
    const activity = this.activity;
    const workspace = this.workspace;
    const runService = this.runService;
    const scheduleService = this.scheduleService;
    const coordinator = this.coordinator;
    const clock = this.clock;
    const ids = this.ids;
    return Effect.gen(function* () {
      const bot = yield* botRepo.findById(id);
      if (!bot) {
        return yield* Effect.fail(new NotFoundError("Bot", String(id)));
      }
      const botId = String(bot.id);
      const conversations = yield* conversationRepo.findAll({ participant: botId });
      const conversationIds = conversations.map((c) => c.id);
      const schedulesToDelete = new Set<string>();
      const addSchedules = (scheduleList: readonly { readonly id: string }[]) => {
        for (const schedule of scheduleList) schedulesToDelete.add(String(schedule.id));
      };
      addSchedules(yield* scheduleService.listSchedules({ botId }));
      addSchedules(yield* scheduleService.listSchedules({ createdBy: botId }));
      for (const scheduleId of schedulesToDelete) {
        yield* scheduleService
          .deleteSchedule(scheduleId)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Deleting schedule during bot deletion failed", scheduleId, cause),
            ),
          );
      }
      const runIds = new Set<string>();
      for (const run of yield* runRepo.findAll({ botId: bot.id })) {
        runIds.add(String(run.id));
      }
      for (const conversationId of conversationIds) {
        for (const run of yield* runRepo.findAll({
          conversationId: conversationId as ConversationId,
        })) {
          runIds.add(String(run.id));
        }
      }
      yield* runService
        .cancelRunsForBot(bot.id)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Cancelling bot runs before deletion failed", botId, cause),
          ),
        );
      for (const conversationId of conversationIds) {
        yield* runService
          .cancelRunsForConversation(conversationId)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError(
                "Cancelling conversation runs before deletion failed",
                String(conversationId),
                cause,
              ),
            ),
          );
      }
      for (const conversation of conversations) {
        yield* coordinator.deleteConversation(String(conversation.id));
      }
      yield* runRepo.deleteByBot(bot.id);
      for (const conversationId of conversationIds) {
        yield* runRepo.deleteByConversation(conversationId);
      }
      yield* sessionRepo.deleteByBot(bot.id);
      yield* taskRepo.deleteByBot(bot.id);
      yield* fileIndex.removeByBot(bot.id);
      yield* workspace.removeHome(bot.id);
      yield* activity.deleteByEntityIds("bot", [botId]);
      if (conversationIds.length > 0) {
        yield* activity.deleteByEntityIds("conversation", conversationIds.map(String));
      }
      if (schedulesToDelete.size > 0) {
        yield* activity.deleteByEntityIds("schedule", [...schedulesToDelete]);
      }
      if (runIds.size > 0) {
        yield* activity.deleteByEntityIds("run", [...runIds]);
      }
      yield* botRepo.delete(bot.id);
      yield* runRepo.deleteByBot(bot.id);
      yield* sessionRepo.deleteByBot(bot.id);
      yield* taskRepo.deleteByBot(bot.id);
      yield* activity
        .create({
          id: asActivityId(ids.generate()),
          type: "bot.deleted",
          entityType: "bot",
          entityId: botId,
          actorId: null,
          payload: { name: bot.name },
          createdAt: clock.now(),
        })
        .pipe(Effect.ignore);
    }) as Effect.Effect<void, NotFoundError | RepositoryError | WorkspaceError>;
  }
}
