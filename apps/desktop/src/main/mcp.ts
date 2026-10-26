import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Effect } from "effect";
import type { BotRepository, RunService } from "@bebots/application";
import type { ConversationRunCoordinator, ScheduleService } from "@bebots/application";
import type { TaskService } from "@bebots/application";
import type { Run, Schedule } from "@bebots/domain";
import { asBotId, nextScheduleFire, validateScheduleTrigger } from "@bebots/domain";

export interface McpDeps {
  readonly botRepo: BotRepository;
  readonly conversationCoordinator: ConversationRunCoordinator;
  readonly runService?: RunService;
  readonly taskService: TaskService;
  /** Present when durable scheduling is wired; enables the schedule tools. */
  readonly scheduleService?: ScheduleService;
}

export interface McpHandle {
  readonly handleRequest: (req: Request) => Promise<Response>;
}

const WINDOW_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 20;
const sendLog = new Map<string, number[]>();

function allowSend(botId: string): boolean {
  const now = Date.now();
  const log = sendLog.get(botId) ?? [];
  const recent = log.filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_SENDS_PER_WINDOW) {
    sendLog.set(botId, recent);
    return false;
  }
  recent.push(now);
  sendLog.set(botId, recent);
  return true;
}

function buildServer(deps: McpDeps): McpServer {
  const { botRepo, conversationCoordinator, runService, taskService, scheduleService } = deps;
  const server = new McpServer({ name: "bebots", version: "1.0.0" });

  server.registerTool(
    "list_bots",
    { description: "List all bots in this bebots instance (id, name, status).", inputSchema: {} },
    async () => {
      const bots = await Effect.runPromise(botRepo.findAll());
      const payload = bots.map((b) => ({ id: String(b.id), name: b.name, status: b.status }));
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send a message to another bot and wait for its reply. Messages you send to the same bot while working on your current task reuse the thread of your first message to that bot — the bot keeps answering from the same session context. Pass conversation_id to post into a specific thread instead.",
      inputSchema: {
        target_bot_id: z.string().describe("The id of the recipient bot"),
        content: z.string().describe("Message content"),
        conversation_id: z.string().optional().describe("Existing conversation id to post into"),
      },
    },
    async (args, extra) => {
      const callerId = extra.authInfo?.clientId;
      if (!callerId) {
        return { content: [{ type: "text", text: "Missing caller identity" }], isError: true };
      }
      if (!allowSend(callerId)) {
        return {
          content: [{ type: "text", text: "Per-bot message rate limit exceeded" }],
          isError: true,
        };
      }
      const target = await Effect.runPromise(botRepo.findById(asBotId(args.target_bot_id)));
      if (!target || target.status !== "active") {
        return {
          content: [{ type: "text", text: "Recipient bot not found or inactive" }],
          isError: true,
        };
      }

      // Route the message: an explicit conversation id wins; otherwise the
      // coordinator resolves (or pins) the direct conversation for this
      // (caller, target) pair so follow-up messages within the caller's turn
      // keep reaching the same conversation — and the same session.
      const conversationId = await Effect.runPromise(
        conversationCoordinator.resolveBotLinkConversation({
          callerBotId: callerId,
          targetBotId: args.target_bot_id,
          ...(args.conversation_id !== undefined && { conversationId: args.conversation_id }),
        }),
      );

      const outcome = await Effect.runPromise(
        conversationCoordinator.sendMessage({
          conversationId,
          content: args.content,
          senderType: "bot",
          senderId: callerId,
        }),
      );

      // Wait for the triggered runs to finish so the caller actually receives
      // the recipient bot's results instead of just run ids.
      const finalRuns: Run[] = [];
      if (runService) {
        for (const r of outcome.runs) {
          const fr = await Effect.runPromise(runService.awaitRun(r.id));
          if (fr) finalRuns.push(fr);
        }
      }
      const finalRun = finalRuns[0] ?? null;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              conversationId,
              messageId: String(outcome.message.id),
              runId: outcome.run?.id ? String(outcome.run.id) : null,
              status: finalRun?.status ?? outcome.run?.status ?? null,
              exitCode: finalRun?.exitCode ?? null,
              summary: finalRun?.summary ?? null,
              error: finalRun?.error ?? null,
              runs: finalRuns.map((r) => ({
                runId: String(r.id),
                status: r.status,
                exitCode: r.exitCode ?? null,
                summary: r.summary ?? null,
                error: r.error ?? null,
              })),
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "create_task",
    {
      description: "Delegate a task to another bot and start a run for it.",
      inputSchema: {
        assignee: z.string().describe("Bot id of the assignee"),
        description: z.string().describe("Task description / prompt"),
      },
    },
    async (args, extra) => {
      const callerId = extra.authInfo?.clientId;
      if (!callerId) {
        return { content: [{ type: "text", text: "Missing caller identity" }], isError: true };
      }
      const task = await Effect.runPromise(
        taskService.delegate({
          requester: callerId,
          assignee: args.assignee,
          description: args.description,
        }),
      );
      return {
        content: [
          { type: "text", text: JSON.stringify({ taskId: String(task.id), status: task.status }) },
        ],
      };
    },
  );

  // Durable scheduling (PLAN §9): bots schedule future bot runs through MCP.
  // A scheduled run is just a prompt handed to a (resumable) session at a
  // trigger time — interval / one-shot / cron in an explicit timezone.
  server.registerTool(
    "schedule_run",
    {
      description:
        "Schedule a future bot run. The prompt is passed to a session for the target bot when the trigger fires (runs happen while the bebots app is running). Pass exactly one trigger: every_minutes, at (one-shot time), or cron (+timezone). Defaults to scheduling yourself; pass bot_id to schedule another bot. By default each schedule gets its own thread with the user: when it fires, the run happens in that conversation and the bot's result is posted there as a reply the user can respond to. Pass conversation_id to route the run into an existing thread instead.",
      inputSchema: {
        prompt: z.string().describe("Prompt delivered to the session when the trigger fires"),
        bot_id: z.string().optional().describe("Target bot id (defaults to yourself)"),
        every_minutes: z.number().optional().describe("Fire every N minutes (minimum 1)"),
        at: z
          .string()
          .optional()
          .describe("One-shot fire time: ISO 8601 string or epoch milliseconds"),
        cron: z.string().optional().describe("5-field cron expression, e.g. '30 9 * * 1-5'"),
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone for cron triggers, e.g. 'America/New_York' (defaults to UTC)"),
        conversation_id: z
          .string()
          .optional()
          .describe(
            "Existing conversation id to post the run into (default: the schedule's own thread with the user)",
          ),
      },
    },
    async (args, extra) => {
      const callerId = extra.authInfo?.clientId;
      if (!callerId) {
        return { content: [{ type: "text", text: "Missing caller identity" }], isError: true };
      }
      if (!scheduleService) {
        return { content: [{ type: "text", text: "Scheduling is not available" }], isError: true };
      }
      const selectors = [
        args.every_minutes !== undefined,
        args.at !== undefined,
        args.cron !== undefined,
      ].filter(Boolean).length;
      if (selectors !== 1) {
        return {
          content: [{ type: "text", text: "Pass exactly one of every_minutes, at, or cron" }],
          isError: true,
        };
      }
      let trigger: unknown;
      if (args.every_minutes !== undefined) {
        if (!Number.isFinite(args.every_minutes) || args.every_minutes < 1) {
          return { content: [{ type: "text", text: "every_minutes must be >= 1" }], isError: true };
        }
        trigger = { kind: "interval", everyMs: Math.round(args.every_minutes * 60_000) };
      } else if (args.at !== undefined) {
        let at: number;
        if (/^\d+$/.test(args.at.trim())) {
          at = Number(args.at.trim());
        } else {
          at = Date.parse(args.at.trim());
        }
        if (!Number.isFinite(at)) {
          return {
            content: [
              { type: "text", text: "at must be an epoch-milliseconds number or ISO 8601 string" },
            ],
            isError: true,
          };
        }
        trigger = { kind: "once", at };
      } else {
        // Validate the cron trigger here so we can probe fireability before
        // any schedule is written: a syntactically valid but impossible
        // expression (e.g. '0 0 30 2 *') matches no real calendar date and
        // would otherwise produce an enabled schedule with nextRunAt: null
        // that silently never fires.
        const validated = validateScheduleTrigger({
          kind: "cron",
          expression: args.cron!.trim(),
          timezone: args.timezone?.trim() || "UTC",
        });
        if (!validated.valid) {
          return {
            content: [{ type: "text", text: `Invalid cron trigger: ${validated.message}` }],
            isError: true,
          };
        }
        if (nextScheduleFire(validated.value, Date.now()) === null) {
          return {
            content: [
              {
                type: "text",
                text: `Cron expression never fires: no calendar date matches '${args.cron!.trim()}' within the scheduler's 5-year scan horizon. Check month/day values against real dates (e.g. February has no 30th).`,
              },
            ],
            isError: true,
          };
        }
        trigger = validated.value;
      }
      const targetBotId = args.bot_id ?? callerId;
      const target = await Effect.runPromise(botRepo.findById(asBotId(targetBotId)));
      if (!target || target.status !== "active") {
        return {
          content: [{ type: "text", text: "Target bot not found or inactive" }],
          isError: true,
        };
      }
      try {
        const schedule = await Effect.runPromise(
          scheduleService.createSchedule({
            botId: targetBotId,
            prompt: args.prompt,
            trigger,
            ...(args.conversation_id !== undefined && { conversationId: args.conversation_id }),
            createdBy: callerId,
          }),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(scheduleToPayload(schedule)) }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to schedule run: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_schedules",
    {
      description:
        "List bot runs you scheduled (schedule_run): trigger definition, target bot, enabled flag, and next run time.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const callerId = extra.authInfo?.clientId;
      if (!callerId) {
        return { content: [{ type: "text", text: "Missing caller identity" }], isError: true };
      }
      if (!scheduleService) {
        return { content: [{ type: "text", text: "Scheduling is not available" }], isError: true };
      }
      const all = await Effect.runPromise(scheduleService.listSchedules());
      const mine = all.filter(
        (s) => String(s.createdBy) === callerId || String(s.botId) === callerId,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(mine.map(scheduleToPayload)) }],
      };
    },
  );

  server.registerTool(
    "cancel_schedule",
    {
      description:
        "Delete one of your scheduled bot runs by its schedule id (list_schedules shows ids).",
      inputSchema: {
        schedule_id: z.string().describe("Id of the schedule to cancel"),
      },
    },
    async (args, extra) => {
      const callerId = extra.authInfo?.clientId;
      if (!callerId) {
        return { content: [{ type: "text", text: "Missing caller identity" }], isError: true };
      }
      if (!scheduleService) {
        return { content: [{ type: "text", text: "Scheduling is not available" }], isError: true };
      }
      const schedule = await Effect.runPromise(scheduleService.getSchedule(args.schedule_id));
      if (
        !schedule ||
        (String(schedule.createdBy) !== callerId && String(schedule.botId) !== callerId)
      ) {
        return {
          content: [{ type: "text", text: "Schedule not found or not yours" }],
          isError: true,
        };
      }
      await Effect.runPromise(scheduleService.deleteSchedule(args.schedule_id));
      return {
        content: [
          { type: "text", text: JSON.stringify({ cancelledScheduleId: args.schedule_id }) },
        ],
      };
    },
  );

  return server;
}

function scheduleToPayload(schedule: Schedule) {
  return {
    scheduleId: String(schedule.id),
    botId: String(schedule.botId),
    prompt: schedule.prompt,
    trigger: schedule.trigger,
    enabled: schedule.enabled,
    conversationId: schedule.conversationId ? String(schedule.conversationId) : null,
    nextRunAt: schedule.nextRunAt ?? null,
    lastRunAt: schedule.lastRunAt ?? null,
  };
}

export async function createMcpServer(deps: McpDeps): Promise<McpHandle> {
  return {
    handleRequest: async (req: Request) => {
      const botId = req.headers.get("x-bebots-bot-id");
      const authInfo = botId ? { token: "", clientId: botId, scopes: [] as string[] } : undefined;
      const server = buildServer(deps);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      const response = await transport.handleRequest(req, authInfo ? { authInfo } : undefined);
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
      return response;
    },
  };
}
