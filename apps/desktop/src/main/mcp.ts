import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Effect } from "effect";
import type { BotRepository, RunService } from "@bebots/application";
import type { ConversationRunCoordinator } from "@bebots/application";
import type { TaskService } from "@bebots/application";
import type { Run } from "@bebots/domain";
import { asBotId } from "@bebots/domain";

export interface McpDeps {
  readonly botRepo: BotRepository;
  readonly conversationCoordinator: ConversationRunCoordinator;
  readonly runService?: RunService;
  readonly taskService: TaskService;
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
  const { botRepo, conversationCoordinator, runService, taskService } = deps;
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
        return { content: [{ type: "text", text: "Per-bot message rate limit exceeded" }], isError: true };
      }
      const target = await Effect.runPromise(botRepo.findById(asBotId(args.target_bot_id)));
      if (!target || target.status !== "active") {
        return { content: [{ type: "text", text: "Recipient bot not found or inactive" }], isError: true };
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
        taskService.delegate({ requester: callerId, assignee: args.assignee, description: args.description }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify({ taskId: String(task.id), status: task.status }) }],
      };
    },
  );

  return server;
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