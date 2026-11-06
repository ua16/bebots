import { useCallback, useEffect, useRef, useState } from "react";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defaultModelSelection, setDefaultModelSelection] = useState<ModelSelection>({
    kind: "runtime-default",
  });

  // Conversations
  const [conversations, setConversations] = useState<readonly ApiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly ApiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
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
  // Chat surface state: toggled bots panel, reply-run indicator, notices.
  const [botsPanelOpen, setBotsPanelOpen] = useState(true);
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

  const selectConversation = (id: string) => {
    activeIdRef.current = id;
    setActiveConversationId(id);
    setMessages([]);
    setPendingReply(false);
    setThreadNotice(null);
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

  const handleSendMessage = async () => {
    if (!endpoint || !activeConversationId || draft.trim().length === 0) return;
    try {
      const reply = await apiRequest(
        endpoint,
        `/api/v1/conversations/${encodeURIComponent(activeConversationId)}/messages`,
        (c) =>
          c.conversations.postMessage({
            params: { id: activeConversationId },
            payload: { content: draft },
          }),
      );
      setDraft("");
      setMentionQuery(null);
      setMentionStart(null);
      setMentionIndex(0);
      setThreadNotice(null);
      await refreshMessages(activeConversationId);
      if (reply.runId !== null) {
        setPendingReply(true);
        pollForReply(activeConversationId, reply.message.createdAt, endpoint);
      } else {
        setPendingReply(false);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleNewConversation = async () => {
    if (!endpoint) return;
    try {
      const conv = await apiRequest(endpoint, "/api/v1/conversations", (c) =>
        c.conversations.createConversation({
          payload: {
            kind: "direct",
            title: "New conversation",
            // Membership is what makes replies trigger: the selected bot (if
            // any) participates, plus the human sender.
            participants: selectedId ? [selectedId, "human"] : ["human"],
          },
        }),
      );
      await refreshConversations();
      selectConversation(conv.id);
    } catch (e) {
      setError(String(e));
    }
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
  const modelGroups: ReadonlyArray<[string, readonly ApiModel[]]> = (() => {
    const groups = new Map<string, ApiModel[]>();
    for (const m of models) {
      const list = groups.get(m.providerID) ?? [];
      list.push(m);
      groups.set(m.providerID, list);
    }
    return [...groups.entries()];
  })();

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
  const participantsLabel = activeConversation
    ? activeConversation.participants.map((p) => botName(p)).join(", ")
    : "";
  const typingBotParticipant = activeConversation?.participants.find((p) =>
    bots.some((b) => b.id === p),
  );
  const typingLabel =
    typingBotParticipant === undefined
      ? "Bot is thinking…"
      : `${botName(typingBotParticipant)} is thinking…`;

  // Keep the thread pinned to the newest message as replies land.
  useEffect(() => {
    const el = threadEndRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "end" });
    }
  }, [messages, pendingReply, threadNotice, activeConversationId]);

  return (
    <main className="app-main">
      <header className="app-header">
        <div className="app-title">
          <h1>bebots</h1>
          <p>Local-first multi-bot agent hub</p>
          <p className="muted">Platform: {platform}</p>
          {workspaceRoot && <p className="muted">Bots home: {workspaceRoot}</p>}
        </div>
        <button
          type="button"
          className="header-toggle"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          {settingsOpen ? "Close settings" : "Settings"}
        </button>
        <button
          type="button"
          className="header-toggle"
          onClick={() => setBotsPanelOpen((open) => !open)}
        >
          {botsPanelOpen ? "Hide bots" : "Show bots"}
        </button>
      </header>
      {error && <p className="error app-error">{error}</p>}

      {settingsOpen && (
        <section className="settings-panel">
          <h2>Settings</h2>
          <label>
            Default model (bots without an override)
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
            <button type="button" onClick={() => void saveAppSettings()}>
              Save settings
            </button>
          </div>
        </section>
      )}

      <section className="chat-layout">
        <aside className="chat-sidebar">
          <div className="chat-sidebar-head">
            <h2>Conversations</h2>
            <button type="button" onClick={handleNewConversation}>
              + New
            </button>
          </div>
          <ul className="chat-list">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={c.id === activeConversationId ? "selected" : ""}
                  onClick={() => selectConversation(c.id)}
                >
                  {c.title || c.id}
                </button>
              </li>
            ))}
            {conversations.length === 0 && <li className="muted">No conversations yet</li>}
          </ul>
        </aside>

        <section className="chat-main">
          {activeConversation ? (
            <>
              <header className="chat-thread-head">
                <h2>{activeConversation.title || activeConversation.id}</h2>
                {participantsLabel.length > 0 && <span className="muted">{participantsLabel}</span>}
              </header>
              <div className="chat-thread">
                {messages.map((m) =>
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
                      <span className="message-sender">
                        {m.senderType === "human" ? "You" : botName(m.senderId)}
                      </span>
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
                {pendingReply && <div className="typing">{typingLabel}</div>}
                {threadNotice !== null && <div className="thread-notice">{threadNotice}</div>}
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
                            className={i === mentionIndex ? "highlighted" : undefined}
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
                <input
                  ref={composerInputRef}
                  value={draft}
                  placeholder="Type a message"
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
                <button type="button" onClick={handleSendMessage}>
                  Send
                </button>
              </form>
            </>
          ) : (
            <div className="chat-empty">
              <p>Pick a conversation on the left, or start a new one to chat with a bot.</p>
              <button type="button" onClick={handleNewConversation}>
                New conversation
              </button>
            </div>
          )}
        </section>

        {botsPanelOpen && (
          <aside className="bots-panel">
            <div className="bot-list">
              <h2>Bots</h2>
              <ul>
                {bots.map((bot) => (
                  <li key={bot.id}>
                    <button
                      type="button"
                      className={bot.id === selectedId ? "selected" : ""}
                      onClick={() => setSelectedId(bot.id)}
                    >
                      {bot.name}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => setSelectedId(null)}>
                New bot
              </button>
            </div>

            <form className="bot-editor" onSubmit={(e) => e.preventDefault()}>
              <h2>{selected ? "Edit bot" : "New bot"}</h2>
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                Description
                <input value={description} onChange={(e) => setDescription(e.target.value)} />
              </label>
              <label>
                Persona
                <textarea value={persona} onChange={(e) => setPersona(e.target.value)} />
              </label>
              <label>
                Model
                <select
                  value={selectionToSelectValue(botModelSelection)}
                  onChange={(e) => {
                    const selection = selectValueToSelection(e.target.value);
                    if (selection) setBotModelSelection(selection);
                  }}
                >
                  <option value={APP_DEFAULT_KEY}>
                    {defaultModelSelection.kind === "runtime-default"
                      ? "OpenCode default"
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
                {selected ? (
                  <>
                    <button type="button" onClick={handleSave}>
                      Save
                    </button>
                    <button type="button" onClick={handleArchive}>
                      Archive
                    </button>
                    <label>
                      Prompt
                      <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                    </label>
                    <button type="button" onClick={handleRun}>
                      Run
                    </button>
                    {runStatus && <p>Run: {runStatus}</p>}
                    {runResult && <pre style={{ whiteSpace: "pre-wrap" }}>{runResult}</pre>}
                    {runHistory.length > 0 && (
                      <div className="run-history">
                        <h3>Run history</h3>
                        <ul>
                          {runHistory.map((run) => (
                            <li key={run.id}>
                              <code>{run.status}</code> {run.prompt.slice(0, 60)}
                              {typeof run.summary === "string" && run.summary.length > 0 && (
                                <pre style={{ whiteSpace: "pre-wrap" }}>
                                  {run.summary.slice(0, 200)}
                                </pre>
                              )}
                              {typeof run.error === "string" && run.error.length > 0 && (
                                <pre className="error">{run.error.slice(0, 200)}</pre>
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
                          <li key={schedule.id} className={schedule.enabled ? "" : "muted"}>
                            <div className="schedule-row">
                              <span className="schedule-trigger">
                                {describeTrigger(schedule.trigger)}
                              </span>
                              <span className="schedule-prompt">
                                {schedule.prompt.slice(0, 60)}
                              </span>
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
                        <button type="button" onClick={() => void handleCreateSchedule()}>
                          Schedule run
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <button type="button" onClick={handleCreate}>
                    Create
                  </button>
                )}
              </div>
            </form>
          </aside>
        )}
      </section>
    </main>
  );
}
