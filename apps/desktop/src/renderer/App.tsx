import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronUp, Plus, Search, Settings, X } from "lucide-react";
import { apiRequest } from "./apiClient";
import type { ApiEndpoint } from "./apiClient";
import type { BebotsPreloadApi, BebotsBot } from "../shared/preload-api";
import { parseModelRef } from "@bebots/domain";
import "./styles.css";

declare global {
  interface Window {
    bebots?: BebotsPreloadApi;
  }
}

interface ApiConversation {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly participants: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ApiMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly senderType: "human" | "bot" | "system";
  readonly senderId?: string | null | undefined;
  readonly content: string;
  readonly createdAt: number;
}

interface ApiRun {
  readonly id: string;
  readonly botId: string;
  readonly status: string;
  readonly prompt: string;
  readonly summary?: string | undefined;
  readonly error?: string | undefined;
  readonly createdAt: number;
}

interface ApiModelRef {
  readonly providerID: string;
  readonly id: string;
}

interface ApiSchedule {
  readonly id: string;
  readonly botId: string;
  readonly prompt: string;
  readonly trigger:
    | { kind: "interval"; everyMs: number }
    | { kind: "once"; at: number }
    | { kind: "cron"; expression: string; timezone: string };
  readonly enabled: boolean;
  /** The schedule's dedicated thread with the user (provisioned on first fire). */
  readonly conversationId?: string | null | undefined;
  readonly nextRunAt?: number | null | undefined;
  readonly lastRunAt?: number | null | undefined;
  readonly createdAt: number;
}

interface ApiScheduleOccurrence {
  readonly id: string;
  readonly scheduleId: string;
  readonly scheduledFor: number;
  readonly status: string;
  readonly runId?: string | null | undefined;
  readonly attempts: number;
  readonly error?: string | null | undefined;
}

/** Short human description of a schedule trigger, e.g. "every 5m" or cron. */
function describeTrigger(trigger: ApiSchedule["trigger"]): string {
  if (trigger.kind === "interval") {
    const minutes = Math.round(trigger.everyMs / 60_000);
    return minutes % 60 === 0 && minutes >= 60
      ? `every ${Math.round(minutes / 60)}h`
      : `every ${minutes}m`;
  }
  if (trigger.kind === "once") {
    return new Date(trigger.at).toLocaleString();
  }
  return `cron ${trigger.expression} (${trigger.timezone})`;
}

interface ApiModel {
  readonly providerID: string;
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * A model-picker selection: which model (if any) to run with, expressed as a
 * union so the two "use no specific model" meanings — follow the app default
 * (bot editor) and use OpenCode's own default (app settings) — stay distinct.
 */
type ModelSelection =
  | { readonly kind: "app-default" }
  | { readonly kind: "runtime-default" }
  | { readonly kind: "ref"; readonly ref: ApiModelRef };

const APP_DEFAULT_KEY = "default";
const RUNTIME_DEFAULT_KEY = "none";

/** A <select> value must be a string, so refs travel JSON-encoded. */
function selectionToSelectValue(selection: ModelSelection): string {
  if (selection.kind === "app-default") return APP_DEFAULT_KEY;
  if (selection.kind === "runtime-default") return RUNTIME_DEFAULT_KEY;
  return JSON.stringify(selection.ref);
}

/** Select value for a catalog model — canonical ref only, so the
 *  `onChange` round-trip through the domain parser reproduces it exactly
 *  (the full `ApiModel` carries extra keys the parser strips). */
function modelToSelectValue(m: ApiModel): string {
  return JSON.stringify({ providerID: m.providerID, id: m.id });
}

/** Inverse of `selectionToSelectValue`; `null` signals an unparseable key. */
function selectValueToSelection(value: string): ModelSelection | null {
  if (value === APP_DEFAULT_KEY) return { kind: "app-default" };
  if (value === RUNTIME_DEFAULT_KEY) return { kind: "runtime-default" };
  // Shared domain parser — the UI does not re-implement model-ref validation.
  const ref = parseModelRef(value);
  return ref ? { kind: "ref", ref } : null;
}

/** A saved model on a bot: `null` means "follow the app default". */
function botModelToSelection(ref: ApiModelRef | null | undefined): ModelSelection {
  return ref ? { kind: "ref", ref } : { kind: "app-default" };
}

/** The user's saved app default; `null` means "OpenCode default". */
function appDefaultToSelection(ref: ApiModelRef | null | undefined): ModelSelection {
  return ref ? { kind: "ref", ref } : { kind: "runtime-default" };
}

/** The model override (or explicit `null`) implied by a selection. */
function selectionToApiModel(selection: ModelSelection): ApiModelRef | null {
  return selection.kind === "ref" ? selection.ref : null;
}

/**
 * Figma palette: bot avatar dots color-code bots across sidebar and threads.
 * A stable hash of the bot id keeps each bot's color fixed across reloads.
 */
const BOT_COLORS: readonly string[] = [
  "#FF0000",
  "#1B73FF",
  "#E41BFF",
  "#63BE58",
  "#FF8800",
  "#00C2D8",
  "#FFD600",
  "#8C64FF",
];

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h;
}

function botColor(id: string | null | undefined): string {
  if (id === null || id === undefined) return "#5A5A5A";
  return BOT_COLORS[hashId(id) % BOT_COLORS.length] ?? "#5A5A5A";
}

function BotAvatar({
  id,
  size,
  title,
}: {
  id: string | null | undefined;
  size: number;
  title?: string | undefined;
}) {
  return (
    <span
      className="bot-avatar"
      style={{ width: size, height: size, backgroundColor: botColor(id) }}
      title={title}
      aria-hidden={title === undefined ? true : undefined}
    />
  );
}

/**
 * One sidebar row per bot, with the bot's sessions nested underneath, newest
 * first. A conversation with several bot participants appears once under
 * every participant; human-only threads land in the trailing group.
 */
interface SessionGroup {
  readonly botId: string;
  readonly name: string;
  readonly sessions: readonly ApiConversation[];
}

const HUMAN_ONLY_GROUP_ID = "__unassigned__";
const HUMAN_ONLY_GROUP_NAME = "Other sessions";

export function App() {
  const [platform, setPlatform] = useState<string>("unknown");
  const [endpoint, setEndpoint] = useState<ApiEndpoint | null>(null);
  const [bots, setBots] = useState<readonly BebotsBot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);

  // Model pickers: catalog from the runtime, per-bot override, global default.
  const [models, setModels] = useState<readonly ApiModel[]>([]);
  const [botModelSelection, setBotModelSelection] = useState<ModelSelection>({
    kind: "app-default",
  });
  const [defaultModelSelection, setDefaultModelSelection] = useState<ModelSelection>({
    kind: "runtime-default",
  });

  // Main surface: the thread (default) or the bot editor sheet.
  const [view, setView] = useState<"chat" | "bot-settings">("chat");
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);

  // Conversations
  const [conversations, setConversations] = useState<readonly ApiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly ApiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  // Sidebar: bot-group expansion (absent = expanded) and search filter.
  const [collapsedBots, setCollapsedBots] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  // Run history for the selected bot
  const [runHistory, setRunHistory] = useState<readonly ApiRun[]>([]);
  // Schedules for the selected bot (durable scheduled runs)
  const [schedules, setSchedules] = useState<readonly ApiSchedule[]>([]);
  // Expanded schedule: its recent occurrence history
  const [scheduleHistory, setScheduleHistory] = useState<{
    id: string;
    occurrences: readonly ApiScheduleOccurrence[];
  } | null>(null);
  const [schedulePrompt, setSchedulePrompt] = useState("");
  const [scheduleMinutes, setScheduleMinutes] = useState("60");
  // Chat surface state: reply-run indicator, notices.
  const [pendingReply, setPendingReply] = useState(false);
  const [threadNotice, setThreadNotice] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const bebots = window.bebots;
  const api = bebots?.bots;

  useEffect(() => {
    setPlatform(window.bebots?.platform ?? "unavailable");
    if (window.bebots?.workspace) {
      void window.bebots.workspace
        .getRoot()
        .then(setWorkspaceRoot)
        .catch(() => {});
    }
    void window.bebots?.apiEndpoint?.().then((e) => {
      if (e) setEndpoint(e);
    });
  }, []);

  const refreshBots = async () => {
    if (!api) return;
    try {
      const list = await api.list(false);
      setBots(list);
    } catch (e) {
      setError(String(e));
    }
  };

  const refreshConversations = useCallback(async () => {
    if (!endpoint) return;
    try {
      setConversations(
        await apiRequest(endpoint, "/api/v1/conversations", (c) =>
          c.conversations.listConversations(),
        ),
      );
    } catch (e) {
      setError(String(e));
    }
  }, [endpoint]);

  useEffect(() => {
    void refreshBots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!endpoint) return;
    void apiRequest(endpoint, "/api/v1/models", (c) => c.models.models())
      .then((list) => setModels(list.filter((m) => m.enabled)))
      .catch(() => {});
    void apiRequest(endpoint, "/api/v1/settings", (c) => c.settings.getSettings())
      .then((s) => setDefaultModelSelection(appDefaultToSelection(s.defaultModel)))
      .catch(() => {});
  }, [endpoint]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // Conversations can also be created by bots via MCP (send_message races and
  // scheduled runs route output into threads the user never opened); poll so
  // new threads appear without user action.
  useEffect(() => {
    if (!endpoint) return;
    const interval = setInterval(() => void refreshConversations(), 60_000);
    return () => clearInterval(interval);
  }, [refreshConversations]);

  const refreshMessages = async (conversationId: string) => {
    if (!endpoint) return;
    try {
      const list = await apiRequest(
        endpoint,
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
        (c) => c.conversations.listMessages({ params: { id: conversationId } }),
      );
      setMessages(list);
    } catch (e) {
      setError(String(e));
    }
  };

  const selectConversation = (id: string, contextBotId?: string | null) => {
    activeIdRef.current = id;
    setActiveConversationId(id);
    setMessages([]);
    setPendingReply(false);
    setThreadNotice(null);
    setView("chat");
    if (contextBotId !== undefined) setSelectedId(contextBotId);
    void refreshMessages(id);
  };

  /**
   * A human message triggers a reply run for a participating bot (full reply
   * loop, PLAN §12 M3). The bot's answer lands asynchronously when its run
   * completes, so poll the thread briefly after sending and drive the typing
   * indicator until it arrives — or surface a notice if it never does.
   */
  const pollForReply = (
    conversationId: string,
    afterCreatedAt: number,
    endpointAt: ApiEndpoint,
  ) => {
    let attempts = 0;
    const tick = () => {
      // The user may have switched conversations while the poll was pending;
      // stop clobbering the thread once it is no longer the visible one.
      if (activeIdRef.current !== conversationId) return;
      attempts += 1;
      void apiRequest(
        endpointAt,
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
        (c) => c.conversations.listMessages({ params: { id: conversationId } }),
      )
        .then((list) => {
          setMessages(list);
          const hasReply = list.some((m) => m.senderType === "bot" && m.createdAt > afterCreatedAt);
          if (hasReply) {
            setPendingReply(false);
            setThreadNotice(null);
            return;
          }
          if (attempts >= 40) {
            setPendingReply(false);
            setThreadNotice(
              "No reply yet — the run may still be in flight or failed. Check run history.",
            );
            return;
          }
          window.setTimeout(tick, 1_500);
        })
        .catch(() => {
          setPendingReply(false);
        });
    };
    window.setTimeout(tick, 1_500);
  };

  const createConversationWith = async (botId: string | null) => {
    if (!endpoint) return null;
    try {
      const conv = await apiRequest(endpoint, "/api/v1/conversations", (c) =>
        c.conversations.createConversation({
          payload: {
            kind: "direct",
            title: "New conversation",
            // Membership is what makes replies trigger: the selected bot (if
            // any) participates, plus the human sender.
            participants: botId ? [botId, "human"] : ["human"],
          },
        }),
      );
      await refreshConversations();
      return conv.id;
    } catch (e) {
      setError(String(e));
      return null;
    }
  };

  const handleSendMessage = async () => {
    if (!endpoint || draft.trim().length === 0) return;
    // Sending from the empty state (a bot is picked but no thread open) starts
    // a fresh thread with that bot, then posts the message.
    let conversationId = activeConversationId;
    if (conversationId === null) {
      conversationId = await createConversationWith(selectedId);
      if (conversationId === null) return;
      activeIdRef.current = conversationId;
      setActiveConversationId(conversationId);
      setMessages([]);
    }
    try {
      const reply = await apiRequest(
        endpoint,
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
        (c) =>
          c.conversations.postMessage({
            params: { id: conversationId },
            payload: { content: draft },
          }),
      );
      setDraft("");
      setMentionQuery(null);
      setMentionStart(null);
      setMentionIndex(0);
      setThreadNotice(null);
      await refreshMessages(conversationId);
      if (reply.runId !== null) {
        setPendingReply(true);
        pollForReply(conversationId, reply.message.createdAt, endpoint);
      } else {
        setPendingReply(false);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleNewConversation = async (withBotId?: string | null) => {
    const botId = withBotId === undefined ? selectedId : withBotId;
    const created = await createConversationWith(botId);
    if (created === null) return;
    selectConversation(created, botId);
  };

  const refreshRunHistory = useCallback(async () => {
    if (!endpoint || !selectedId) {
      setRunHistory([]);
      return;
    }
    try {
      setRunHistory(
        await apiRequest(endpoint, `/api/v1/bots/${encodeURIComponent(selectedId)}/runs`, (c) =>
          c.bots.listBotRuns({ params: { id: selectedId } }),
        ),
      );
    } catch (e) {
      setError(String(e));
    }
  }, [endpoint, selectedId]);

  const selected = bots.find((b) => b.id === selectedId) ?? null;

  const refreshSchedules = useCallback(async () => {
    if (!endpoint || !selectedId) {
      setSchedules([]);
      return;
    }
    try {
      const all = await apiRequest(
        endpoint,
        `/api/v1/schedules?botId=${encodeURIComponent(selectedId)}`,
        (c) => c.schedules.listSchedules({ query: { botId: selectedId } }),
      );
      setSchedules([...all].sort((a, b) => b.createdAt - a.createdAt));
    } catch (e) {
      setError(String(e));
    }
  }, [endpoint, selectedId]);

  // Re-fetch the expanded schedule's occurrence history so statuses
  // (pending → enqueued → succeeded/failed) update after a trigger fires
  // without the user having to toggle History again.
  const refreshScheduleHistory = useCallback(async () => {
    const id = scheduleHistory?.id;
    if (!endpoint || !id) return;
    try {
      const occurrences = await apiRequest(
        endpoint,
        `/api/v1/schedules/${encodeURIComponent(id)}/occurrences?limit=10`,
        (c) => c.schedules.listOccurrences({ params: { id }, query: { limit: 10 } }),
      );
      setScheduleHistory({ id, occurrences });
    } catch (e) {
      setError(String(e));
    }
  }, [endpoint, scheduleHistory?.id]);

  useEffect(() => {
    if (selected) {
      void refreshRunHistory();
      void refreshSchedules();
    } else {
      setRunHistory([]);
      setSchedules([]);
      setScheduleHistory(null);
    }
  }, [selected, refreshRunHistory, refreshSchedules]);

  // Schedules and runs can also be created/advanced by bots via MCP, which
  // the renderer can't see; poll the schedule list, run history, and any
  // expanded occurrence history while a bot is selected.
  useEffect(() => {
    if (!selected) return;
    const interval = setInterval(() => {
      void refreshSchedules();
      void refreshRunHistory();
      void refreshScheduleHistory();
    }, 15_000);
    return () => clearInterval(interval);
  }, [selected, refreshSchedules, refreshRunHistory, refreshScheduleHistory]);

  // The open thread can receive messages from outside the composer — a
  // scheduled-run reply lands in its own thread whenever the scheduler fires.
  // Refresh on the same 15s cadence so it appears without user action.
  useEffect(() => {
    if (!activeConversationId) return;
    const interval = setInterval(() => {
      if (activeIdRef.current === activeConversationId) {
        void refreshMessages(activeConversationId);
      }
    }, 15_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

  useEffect(() => {
    if (selected) {
      setName(selected.name);
      setDescription(selected.description);
      setPersona(selected.persona);
      setBotModelSelection(botModelToSelection(selected.model));
    } else {
      setName("");
      setDescription("");
      setPersona("");
      setBotModelSelection({ kind: "app-default" });
    }
  }, [selected]);

  // Group the model catalog by provider (stable, response order) for optgroups.
  const modelGroups: ReadonlyArray<[string, readonly ApiModel[]]> = useMemo(() => {
    const groups = new Map<string, ApiModel[]>();
    for (const m of models) {
      const list = groups.get(m.providerID) ?? [];
      list.push(m);
      groups.set(m.providerID, list);
    }
    return [...groups.entries()];
  }, [models]);

  const saveAppSettings = async () => {
    if (!endpoint) return;
    setError(null);
    try {
      const s = await apiRequest(endpoint, "/api/v1/settings", (c) =>
        c.settings.putSettings({
          payload: { defaultModel: selectionToApiModel(defaultModelSelection) },
        }),
      );
      setDefaultModelSelection(appDefaultToSelection(s.defaultModel));
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCreate = async () => {
    if (!api) return;
    setError(null);
    try {
      const bot = await api.create({
        name: name || "New bot",
        description,
        persona,
        model: selectionToApiModel(botModelSelection),
      });
      setSelectedId(bot.id);
      await refreshBots();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleSave = async () => {
    if (!api || !selectedId) return;
    setError(null);
    try {
      await api.update(selectedId, {
        name,
        description,
        persona,
        model: selectionToApiModel(botModelSelection),
      });
      await refreshBots();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleArchive = async () => {
    if (!api || !selectedId) return;
    setError(null);
    try {
      await api.archive(selectedId);
      setSelectedId(null);
      await refreshBots();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRun = async () => {
    if (!api || !selectedId) return;
    setError(null);
    setRunStatus("running");
    try {
      const run = await bebots!.runs.start({ botId: selectedId, prompt: prompt || "Hello" });
      const final = await bebots!.runs.await(run.id, 120000);
      setRunStatus(final?.status ?? run.status);
      setRunResult(final?.summary ?? null);
      void refreshRunHistory();
    } catch (e) {
      setError(String(e));
      setRunStatus("failed");
    }
  };

  const handleCreateSchedule = async () => {
    if (!endpoint || !selectedId) return;
    setError(null);
    const minutes = Number(scheduleMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) {
      setError("Interval must be at least 1 minute");
      return;
    }
    try {
      await apiRequest(endpoint, "/api/v1/schedules", (c) =>
        c.schedules.createSchedule({
          payload: {
            botId: selectedId,
            prompt: schedulePrompt,
            trigger: { kind: "interval", everyMs: Math.round(minutes * 60_000) },
          },
        }),
      );
      setSchedulePrompt("");
      await refreshSchedules();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleToggleSchedule = async (schedule: ApiSchedule) => {
    if (!endpoint) return;
    setError(null);
    try {
      await apiRequest(endpoint, `/api/v1/schedules/${encodeURIComponent(schedule.id)}`, (c) =>
        c.schedules.updateSchedule({
          params: { id: schedule.id },
          payload: { enabled: !schedule.enabled },
        }),
      );
      setScheduleHistory(null);
      await refreshSchedules();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDeleteSchedule = async (schedule: ApiSchedule) => {
    if (!endpoint) return;
    setError(null);
    try {
      await apiRequest(endpoint, `/api/v1/schedules/${encodeURIComponent(schedule.id)}`, (c) =>
        c.schedules.deleteSchedule({ params: { id: schedule.id } }),
      );
      setScheduleHistory(null);
      await refreshSchedules();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleShowScheduleHistory = async (schedule: ApiSchedule) => {
    if (!endpoint) return;
    if (scheduleHistory?.id === schedule.id) {
      setScheduleHistory(null);
      return;
    }
    try {
      const occurrences = await apiRequest(
        endpoint,
        `/api/v1/schedules/${encodeURIComponent(schedule.id)}/occurrences?limit=10`,
        (c) => c.schedules.listOccurrences({ params: { id: schedule.id }, query: { limit: 10 } }),
      );
      setScheduleHistory({ id: schedule.id, occurrences });
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleBotExpanded = (botId: string) => {
    setSelectedId(botId);
    setView("chat");
    setCollapsedBots((prev) => {
      const next = new Set(prev);
      if (next.has(botId)) {
        next.delete(botId);
      } else {
        next.add(botId);
      }
      return next;
    });
  };

  /**
   * Sidebar groups: bots ordered by their newest session (recency rank),
   * each with that bot's sessions newest-first. Multi-bot threads repeat
   * under every participant; human-only threads tail in a shared group.
   */
  const sessionGroups: readonly SessionGroup[] = useMemo(() => {
    const byBot = new Map<string, ApiConversation[]>();
    const orphans: ApiConversation[] = [];
    const chronological = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const conv of chronological) {
      const botIds = conv.participants.filter((p) => p !== "human");
      if (botIds.length === 0) orphans.push(conv);
      for (const botId of botIds) {
        const list = byBot.get(botId) ?? [];
        list.push(conv);
        byBot.set(botId, list);
      }
    }
    const groups: SessionGroup[] = bots.map((bot) => ({
      botId: bot.id,
      name: bot.name,
      sessions: byBot.get(bot.id) ?? [],
    }));
    const newestAt = (g: SessionGroup) => g.sessions[0]?.updatedAt ?? 0;
    groups.sort((a, b) => {
      if (newestAt(a) !== newestAt(b)) return newestAt(b) - newestAt(a);
      return a.name.localeCompare(b.name);
    });
    if (orphans.length > 0) {
      groups.push({
        botId: HUMAN_ONLY_GROUP_ID,
        name: HUMAN_ONLY_GROUP_NAME,
        sessions: orphans,
      });
    }
    return groups;
  }, [bots, conversations]);

  const mentionSuggestions =
    mentionQuery === null
      ? []
      : bots.filter(
          (b) =>
            b.name.toLowerCase().includes(mentionQuery.toLowerCase()) ||
            b.id.toLowerCase().includes(mentionQuery.toLowerCase()),
        );

  const selectMention = useCallback(
    (bot: BebotsBot) => {
      if (mentionStart === null || mentionQuery === null) return;
      const before = draft.slice(0, mentionStart);
      const after = draft.slice(mentionStart + 1 + mentionQuery.length);
      setDraft(`${before}@${bot.id} ${after}`);
      setMentionQuery(null);
      setMentionStart(null);
      setMentionIndex(0);
      composerInputRef.current?.focus();
    },
    [draft, mentionQuery, mentionStart],
  );

  const renderMentionContent = (content: string) => {
    const parts = content.split(/(@[A-Za-z0-9_-]+)/g);
    return parts.map((part, index) => {
      const match = part.match(/^@([A-Za-z0-9_-]+)$/);
      if (match) {
        const mentioned = bots.find((b) => b.id === match[1]);
        if (mentioned) {
          return (
            <span key={index} className="mention">
              @<span className="mention-name">{mentioned.name}</span>
            </span>
          );
        }
      }
      return <span key={index}>{part}</span>;
    });
  };

  const activeConversation = conversations.find((c) => c.id === activeConversationId) ?? null;
  const botName = (id: string | null | undefined) => {
    if (id === null || id === undefined) return "Bot";
    return bots.find((b) => b.id === id)?.name ?? id;
  };
  // The thread's bot participants drive the header identity: the primary bot
  // is whichever participant is currently selected (so session pill context
  // wins), falling back to the first bot participant.
  const threadBotIds = useMemo(
    () => (activeConversation?.participants ?? []).filter((p) => bots.some((b) => b.id === p)),
    [activeConversation, bots],
  );
  const headerBotId =
    selectedId !== null && threadBotIds.includes(selectedId)
      ? selectedId
      : (threadBotIds[0] ?? null);
  const headerBot = bots.find((b) => b.id === headerBotId) ?? null;
  const extraBotIds = threadBotIds.filter((id) => id !== headerBotId);
  const headerTitle = headerBot
    ? headerBot.name
    : (activeConversation?.title ?? selected?.name ?? "bebots hub");
  const participantsLabel = activeConversation
    ? activeConversation.participants.map((p) => botName(p)).join(", ")
    : "";
  const typingBotParticipant = threadBotIds[0];
  const typingLabel =
    typingBotParticipant === undefined
      ? "Bot is thinking…"
      : `${botName(typingBotParticipant)} is thinking…`;
  const composerPlaceholder = headerBot !== null ? `Message ${headerBot.name}` : "Type a message";

  // Sidebar filtering: a bot's name match keeps its whole group visible; a
  // session-title match shows that session within any group.
  const query = search.trim().toLowerCase();
  const visibleGroups = query
    ? sessionGroups
        .map((group) => ({
          group,
          matches: group.sessions.filter((c) => (c.title || c.id).toLowerCase().includes(query)),
        }))
        .filter(
          ({ group, matches }) => group.name.toLowerCase().includes(query) || matches.length > 0,
        )
        .map(({ group, matches }) => ({
          ...group,
          sessions: group.name.toLowerCase().includes(query) ? group.sessions : matches,
        }))
    : [...sessionGroups];

  // Keep the thread pinned to the newest message as replies land.
  useEffect(() => {
    const el = threadEndRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "end" });
    }
  }, [messages, pendingReply, threadNotice, activeConversationId]);

  return (
    <main className="app-main">
      {/* Product identity and environment info, visually hidden but exposed
          to assistive tech and tests. */}
      <header className="sr-only">
        <h1>bebots</h1>
        <p>Local-first multi-bot agent hub</p>
        <p>Platform: {platform}</p>
        {workspaceRoot && <p>Bots home: {workspaceRoot}</p>}
      </header>
      {error && <p className="error app-error">{error}</p>}

      <div className="app-shell">
        {/* ------------------------------------------------------------ */}
        {/* Sidebar: search + new session, bot-grouped session list.       */}
        {/* ------------------------------------------------------------ */}
        <aside className="chat-sidebar">
          <div className="chat-search">
            <Search size={22} strokeWidth={2.4} aria-hidden />
            <input
              type="search"
              placeholder="Search"
              value={search}
              aria-label="Search sessions"
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              className="icon-pill-button"
              aria-label="New session"
              title="New session"
              onClick={() => void handleNewConversation()}
            >
              <Plus size={24} strokeWidth={2.6} aria-hidden />
            </button>
          </div>

          <div className="chat-groups">
            {visibleGroups.map((group) => {
              const expanded = !collapsedBots.has(group.botId);
              return (
                <div key={group.botId} className="session-group">
                  <button
                    type="button"
                    className={"bot-row" + (group.botId === selectedId ? " bot-row-selected" : "")}
                    aria-expanded={expanded}
                    aria-controls={`sessions-${group.botId}`}
                    onClick={() => toggleBotExpanded(group.botId)}
                  >
                    <BotAvatar id={group.botId} size={49} />
                    <span className="bot-row-name">{group.name}</span>
                    {expanded ? (
                      <ChevronUp size={24} strokeWidth={3} aria-hidden />
                    ) : (
                      <ChevronDown size={24} strokeWidth={3} aria-hidden />
                    )}
                  </button>
                  {expanded && (
                    <ul id={`sessions-${group.botId}`} className="session-pills">
                      {group.sessions.map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            className={
                              "session-pill" + (c.id === activeConversationId ? " selected" : "")
                            }
                            onClick={() =>
                              group.botId === HUMAN_ONLY_GROUP_ID
                                ? selectConversation(c.id)
                                : selectConversation(c.id, group.botId)
                            }
                          >
                            {c.title || c.id}
                          </button>
                        </li>
                      ))}
                      {group.sessions.length === 0 && (
                        <li className="session-empty">No sessions yet</li>
                      )}
                    </ul>
                  )}
                </div>
              );
            })}
            {visibleGroups.length === 0 && <p className="session-empty">No conversations yet</p>}
          </div>
        </aside>

        {/* ------------------------------------------------------------- */}
        {/* Workspace: header identity bar, thread or bot settings.        */}
        {/* ------------------------------------------------------------- */}
        <section className="chat-main">
          <header className="chat-thread-head">
            {headerBot !== null ? <BotAvatar id={headerBot.id} size={59} /> : null}
            <div className="thread-head-titles">
              <h2>{headerTitle}</h2>
              {threadBotIds.length > 1 && <p className="muted">{participantsLabel}</p>}
            </div>
            {extraBotIds.length > 0 && (
              <div className="thread-extra-avatars" aria-hidden>
                {extraBotIds.map((id) => (
                  <BotAvatar key={id} id={id} size={30} />
                ))}
              </div>
            )}
            <button
              type="button"
              className={"icon-pill-button" + (view === "bot-settings" ? " toggled" : "")}
              aria-label="Bot settings"
              title={headerBot ? `${headerBot.name} settings` : "Bot settings"}
              onClick={() => setView((v) => (v === "bot-settings" ? "chat" : "bot-settings"))}
            >
              <Settings size={26} strokeWidth={2.2} aria-hidden />
            </button>
          </header>

          {view === "bot-settings" ? (
            <section className="bot-editor settings-scroll">
              <button
                type="button"
                className="pill-button"
                onClick={() => setGlobalSettingsOpen(true)}
              >
                Open Global Settings
              </button>

              {selected ? (
                <>
                  <label className="settings-field">
                    <span>Name</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>Description</span>
                    <input value={description} onChange={(e) => setDescription(e.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>Persona</span>
                    <textarea
                      placeholder="Your bot's system prompt, this forms its AGENT.md"
                      value={persona}
                      onChange={(e) => setPersona(e.target.value)}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Model</span>
                    <select
                      value={selectionToSelectValue(botModelSelection)}
                      onChange={(e) => {
                        const selection = selectValueToSelection(e.target.value);
                        if (selection) setBotModelSelection(selection);
                      }}
                    >
                      <option value={APP_DEFAULT_KEY}>
                        {defaultModelSelection.kind === "runtime-default"
                          ? "Global Default"
                          : "Use app default"}
                      </option>
                      {modelGroups.map(([provider, items]) => (
                        <optgroup key={provider} label={provider}>
                          {items.map((m) => (
                            <option key={`${m.providerID}/${m.id}`} value={modelToSelectValue(m)}>
                              {m.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>

                  <div className="actions">
                    <button type="button" className="pill-button" onClick={handleSave}>
                      Save
                    </button>
                    <button type="button" className="pill-button" onClick={handleArchive}>
                      Archive
                    </button>
                  </div>

                  <label className="settings-field run-field">
                    <span>Prompt</span>
                    <div className="run-row">
                      <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                      <button type="button" className="pill-button" onClick={handleRun}>
                        Run
                      </button>
                    </div>
                  </label>
                  {runStatus && <p className="run-status">Run: {runStatus}</p>}
                  {runResult !== null && <pre className="log">{runResult}</pre>}
                  {runHistory.length > 0 && (
                    <div className="run-history">
                      <h3>Run history</h3>
                      <ul>
                        {runHistory.map((run) => (
                          <li key={run.id} className="card-row">
                            <code>{run.status}</code> {run.prompt.slice(0, 60)}
                            {typeof run.summary === "string" && run.summary.length > 0 && (
                              <pre className="log">{run.summary.slice(0, 200)}</pre>
                            )}
                            {typeof run.error === "string" && run.error.length > 0 && (
                              <pre className="log error">{run.error.slice(0, 200)}</pre>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="schedule-panel">
                    <h3>Schedules</h3>
                    <ul className="schedule-list">
                      {schedules.length === 0 && <li className="muted">No scheduled runs</li>}
                      {schedules.map((schedule) => (
                        <li
                          key={schedule.id}
                          className={"card-row" + (schedule.enabled ? "" : " muted")}
                        >
                          <div className="schedule-row">
                            <span className="schedule-trigger">
                              {describeTrigger(schedule.trigger)}
                            </span>
                            <span className="schedule-prompt">{schedule.prompt.slice(0, 60)}</span>
                          </div>
                          <div className="schedule-meta">
                            {schedule.enabled
                              ? schedule.nextRunAt
                                ? `next: ${new Date(schedule.nextRunAt).toLocaleString()}`
                                : "no upcoming fire"
                              : "paused"}
                          </div>
                          <div className="schedule-actions">
                            <button
                              type="button"
                              onClick={() => void handleToggleSchedule(schedule)}
                            >
                              {schedule.enabled ? "Pause" : "Enable"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleShowScheduleHistory(schedule)}
                            >
                              History
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteSchedule(schedule)}
                            >
                              Delete
                            </button>
                            {schedule.conversationId &&
                              conversations.some((c) => c.id === schedule.conversationId) && (
                                <button
                                  type="button"
                                  onClick={() => selectConversation(schedule.conversationId!)}
                                >
                                  Open thread
                                </button>
                              )}
                          </div>
                          {scheduleHistory?.id === schedule.id && (
                            <ul className="schedule-occurrences">
                              {scheduleHistory.occurrences.length === 0 && (
                                <li className="muted">No occurrences yet</li>
                              )}
                              {scheduleHistory.occurrences.map((occ) => (
                                <li key={occ.id}>
                                  <code>{occ.status}</code>{" "}
                                  {new Date(occ.scheduledFor).toLocaleString()}
                                  {occ.error ? ` — ${occ.error.slice(0, 80)}` : ""}
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                    <div className="schedule-new">
                      <label>
                        Schedule prompt
                        <input
                          value={schedulePrompt}
                          placeholder="Prompt to run on schedule"
                          onChange={(e) => setSchedulePrompt(e.target.value)}
                        />
                      </label>
                      <label>
                        Every (minutes)
                        <input
                          value={scheduleMinutes}
                          inputMode="numeric"
                          onChange={(e) => setScheduleMinutes(e.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="pill-button"
                        onClick={() => void handleCreateSchedule()}
                      >
                        Schedule run
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <h2>New bot</h2>
                  <label className="settings-field">
                    <span>Name</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>Description</span>
                    <input value={description} onChange={(e) => setDescription(e.target.value)} />
                  </label>
                  <label className="settings-field">
                    <span>Persona</span>
                    <textarea
                      placeholder="Your bot's system prompt, this forms its AGENT.md"
                      value={persona}
                      onChange={(e) => setPersona(e.target.value)}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Model</span>
                    <select
                      value={selectionToSelectValue(botModelSelection)}
                      onChange={(e) => {
                        const selection = selectValueToSelection(e.target.value);
                        if (selection) setBotModelSelection(selection);
                      }}
                    >
                      <option value={APP_DEFAULT_KEY}>
                        {defaultModelSelection.kind === "runtime-default"
                          ? "Global Default"
                          : "Use app default"}
                      </option>
                      {modelGroups.map(([provider, items]) => (
                        <optgroup key={provider} label={provider}>
                          {items.map((m) => (
                            <option key={`${m.providerID}/${m.id}`} value={modelToSelectValue(m)}>
                              {m.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <div className="actions">
                    <button type="button" className="pill-button" onClick={handleCreate}>
                      Create
                    </button>
                  </div>
                </>
              )}
            </section>
          ) : (
            <>
              <div className="chat-thread">
                {activeConversation &&
                  messages.map((m) =>
                    m.senderType === "system" ? (
                      <div key={m.id} className="message message-system">
                        <span className="message-content">{m.content}</span>
                        <time className="message-time">
                          {new Date(m.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                    ) : (
                      <div
                        key={m.id}
                        className={`message ${m.senderType === "human" ? "message-human" : "message-bot"}`}
                      >
                        {m.senderType === "bot" ? (
                          <span className="message-identity">
                            <BotAvatar id={m.senderId} size={22} />
                            <span className="message-sender">{botName(m.senderId)}</span>
                          </span>
                        ) : (
                          <span className="message-identity">
                            <span className="message-sender">You</span>
                          </span>
                        )}
                        <span className="message-content">{renderMentionContent(m.content)}</span>
                        <time className="message-time">
                          {new Date(m.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                    ),
                  )}
                {activeConversation && pendingReply && <div className="typing">{typingLabel}</div>}
                {threadNotice !== null && <div className="thread-notice">{threadNotice}</div>}
                {!activeConversation && (
                  <p className="thread-empty-hint">
                    No session selected — say hello to start one with{" "}
                    {headerBot?.name ?? "this bot"}.
                  </p>
                )}
                <div ref={threadEndRef} />
              </div>
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSendMessage();
                }}
              >
                {mentionQuery !== null && mentionSuggestions.length > 0 && (
                  <div
                    className="mention-popup mention-frame mention-menu"
                    role="listbox"
                    aria-label="Mention suggestions"
                    data-testid="mention-suggestions"
                  >
                    <ul className="mention-suggestions">
                      {mentionSuggestions.map((b, i) => (
                        <li key={b.id}>
                          <button
                            type="button"
                            className={
                              "mention-option" + (i === mentionIndex ? " highlighted" : "")
                            }
                            aria-selected={i === mentionIndex}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => selectMention(b)}
                          >
                            {b.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <button
                  type="button"
                  className="icon-pill-button"
                  aria-label="New session"
                  title="New session"
                  onClick={() => void handleNewConversation()}
                >
                  <Plus size={24} strokeWidth={2.6} aria-hidden />
                </button>
                <input
                  ref={composerInputRef}
                  value={draft}
                  placeholder={composerPlaceholder}
                  onChange={(e) => {
                    const value = e.target.value;
                    setDraft(value);
                    const caret = e.target.selectionStart ?? value.length;
                    const idx = value.lastIndexOf("@", caret - 1);
                    if (idx !== -1) {
                      const between = value.slice(idx + 1, caret);
                      if (!/\s/.test(between)) {
                        if (idx === 0 || /\s/.test(value[idx - 1] ?? "")) {
                          setMentionQuery(between);
                          setMentionStart(idx);
                          setMentionIndex(0);
                        } else {
                          setMentionQuery(null);
                          setMentionStart(null);
                        }
                      } else {
                        setMentionQuery(null);
                        setMentionStart(null);
                      }
                    } else {
                      setMentionQuery(null);
                      setMentionStart(null);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (mentionQuery !== null && mentionSuggestions.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setMentionIndex((i) => (i + 1) % mentionSuggestions.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setMentionIndex(
                          (i) => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length,
                        );
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        const chosen = mentionSuggestions[mentionIndex] ?? mentionSuggestions[0];
                        if (chosen) selectMention(chosen);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setMentionQuery(null);
                        setMentionStart(null);
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendMessage();
                    }
                  }}
                />
                <button type="submit" className="icon-send" aria-label="Send" title="Send">
                  <ArrowUp size={24} strokeWidth={3} aria-hidden />
                </button>
              </form>
            </>
          )}
        </section>
      </div>

      {globalSettingsOpen && (
        <div
          className="settings-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Global settings"
        >
          <section className="global-settings">
            <div className="overlay-head">
              <h2>Global settings</h2>
              <button
                type="button"
                className="icon-pill-button"
                aria-label="Close global settings"
                onClick={() => setGlobalSettingsOpen(false)}
              >
                <X size={22} strokeWidth={2.6} aria-hidden />
              </button>
            </div>
            <label className="settings-field">
              <span>Default model (bots without an override)</span>
              <select
                value={selectionToSelectValue(defaultModelSelection)}
                onChange={(e) => {
                  const selection = selectValueToSelection(e.target.value);
                  if (selection) setDefaultModelSelection(selection);
                }}
              >
                <option value={RUNTIME_DEFAULT_KEY}>OpenCode default</option>
                {modelGroups.map(([provider, items]) => (
                  <optgroup key={provider} label={provider}>
                    {items.map((m) => (
                      <option key={`${m.providerID}/${m.id}`} value={modelToSelectValue(m)}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="actions">
              <button type="button" className="pill-button" onClick={() => void saveAppSettings()}>
                Save settings
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
