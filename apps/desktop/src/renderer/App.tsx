import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "./apiClient";
import type { ApiEndpoint } from "./apiClient";
import type { BebotsPreloadApi, BebotsBot } from "../shared/preload-api";
import type {
  ApiConversation,
  ApiMessage,
  ApiModel,
  ApiRun,
  ApiSchedule,
  ApiScheduleOccurrence,
} from "./lib/api-types";
import {
  appDefaultToSelection,
  botModelToSelection,
  groupModelsByProvider,
  selectionToApiModel,
  type ModelSelection,
} from "./lib/model-selection";
import { UNASSIGNED_GROUP_ID, groupSidebarSessions, type SessionGroup } from "./lib/sidebar-groups";
import { botName } from "./lib/bot-name";
import { Sidebar } from "./components/Sidebar";
import { ThreadHeader } from "./components/ThreadHeader";
import { GlobalSettingsOverlay } from "./components/GlobalSettingsOverlay";
import { Dialog } from "./components/Dialog";
import { BotEditor } from "./components/BotEditor";
import { MessageThread } from "./components/MessageThread";
import { Composer } from "./components/Composer";
import { useMentions } from "./hooks/useMentions";
import "./styles.css";

declare global {
  interface Window {
    bebots?: BebotsPreloadApi;
  }
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
  const [defaultModelSelection, setDefaultModelSelection] = useState<ModelSelection>({
    kind: "runtime-default",
  });

  // Main surface: the thread (default) or the bot editor sheet.
  const [view, setView] = useState<"chat" | "bot-settings">("chat");
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [pendingDeleteBotId, setPendingDeleteBotId] = useState<string | null>(null);

  // Conversations
  const [conversations, setConversations] = useState<readonly ApiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly ApiMessage[]>([]);
  const [draft, setDraft] = useState("");
  // Sidebar: bot-group expansion (absent = expanded).
  const [collapsedBots, setCollapsedBots] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");
  // Bot groups whose session list is fully expanded (beyond the 5 most recent).
  const [expandedSessions, setExpandedSessions] = useState<ReadonlySet<string>>(new Set());
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
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
  }, [endpoint, refreshConversations]);

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
      mentions.clearMentions();
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
  const modelGroups: ReadonlyArray<[string, readonly ApiModel[]]> = useMemo(
    () => groupModelsByProvider(models),
    [models],
  );

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
      setView("bot-settings");
      await refreshBots();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCreateBot = async () => {
    if (!api) return;
    setError(null);
    try {
      const bot = await api.create({
        name: "New bot",
        description: "",
        persona: "",
        model: null,
      });
      setSelectedId(bot.id);
      setView("bot-settings");
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

  // Deleting a bot hard-deletes it with all tied data (threads, runs,
  // schedules); clear whatever UI state pointed at it.
  const handleDeleteBot = async (botId: string) => {
    if (!endpoint) return;
    setError(null);
    setPendingDeleteBotId(null);
    try {
      await apiRequest(endpoint, `/api/v1/bots/${encodeURIComponent(botId)}`, (c) =>
        c.bots.deleteBot({ params: { id: botId } }),
      );
      if (selectedId === botId) {
        setSelectedId(null);
        setView("chat");
      }
      if (
        activeConversationId !== null &&
        conversations.some((c) => c.id === activeConversationId && c.participants.includes(botId))
      ) {
        activeIdRef.current = null;
        setActiveConversationId(null);
        setMessages([]);
        setPendingReply(false);
        setThreadNotice(null);
      }
      await refreshBots();
      await refreshConversations();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDeleteConversation = async (conversationId: string) => {
    if (!endpoint) return;
    setError(null);
    try {
      await apiRequest(
        endpoint,
        `/api/v1/conversations/${encodeURIComponent(conversationId)}`,
        (c) => c.conversations.deleteConversation({ params: { id: conversationId } }),
      );
      if (activeConversationId === conversationId) {
        activeIdRef.current = null;
        setActiveConversationId(null);
        setMessages([]);
        setPendingReply(false);
        setThreadNotice(null);
      }
      await refreshConversations();
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
    // Selecting the synthetic "other sessions" group must not masquerade as a
    // bot: it has no bot record, so selecting it would feed a fake id into
    // run/schedule lookups and the bot-settings form.
    if (botId !== UNASSIGNED_GROUP_ID) {
      setSelectedId(botId);
    }
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

  const toggleShowAllSessions = (botId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(botId)) {
        next.delete(botId);
      } else {
        next.add(botId);
      }
      return next;
    });
  };

  const sessionGroups: readonly SessionGroup[] = useMemo(
    () => groupSidebarSessions(bots, conversations),
    [bots, conversations],
  );

  // "@" mention machinery for the composer (detection, popup navigation, completion).
  const mentions = useMentions({
    draft,
    setDraft,
    bots,
    inputRef: composerInputRef,
    onSend: () => void handleSendMessage(),
  });

  const activeConversation = conversations.find((c) => c.id === activeConversationId) ?? null;
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
    ? activeConversation.participants.map((p) => botName(bots, p)).join(", ")
    : "";
  const typingBotParticipant = threadBotIds[0];
  const typingLabel =
    typingBotParticipant === undefined
      ? "Bot is thinking…"
      : `${botName(bots, typingBotParticipant)} is thinking…`;
  const composerPlaceholder = headerBot !== null ? `Message ${headerBot.name}` : "Type a message";

  // Keep the thread pinned to the newest message as replies land.
  useEffect(() => {
    const el = threadEndRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "end" });
    }
  }, [messages, pendingReply, threadNotice, activeConversationId]);

  // Auto-grow the composer textarea to fit its content.
  useEffect(() => {
    const el = composerInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

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
        <Sidebar
          groups={sessionGroups}
          search={search}
          onSearchChange={setSearch}
          selectedId={selectedId}
          activeConversationId={activeConversationId}
          collapsedBots={collapsedBots}
          expandedSessions={expandedSessions}
          onToggleBotExpanded={toggleBotExpanded}
          onToggleShowAllSessions={toggleShowAllSessions}
          onSelectConversation={selectConversation}
          onNewConversation={handleNewConversation}
          onCreateBot={() => void handleCreateBot()}
          onDeleteBot={setPendingDeleteBotId}
          onDeleteSession={(conversationId) => void handleDeleteConversation(conversationId)}
        />

        {/* ------------------------------------------------------------- */}
        {/* Workspace: header identity bar, thread or bot settings.        */}
        {/* ------------------------------------------------------------- */}
        <section className="chat-main">
          <ThreadHeader
            headerBot={headerBot}
            headerTitle={headerTitle}
            threadBotIds={threadBotIds}
            extraBotIds={extraBotIds}
            participantsLabel={participantsLabel}
            settingsOpen={view === "bot-settings"}
            onToggleSettings={() =>
              setView((v) => (v === "bot-settings" ? "chat" : "bot-settings"))
            }
          />

          {view === "bot-settings" ? (
            <BotEditor
              selected={selected}
              name={name}
              onNameChange={setName}
              description={description}
              onDescriptionChange={setDescription}
              persona={persona}
              onPersonaChange={setPersona}
              modelSelection={botModelSelection}
              onModelSelect={setBotModelSelection}
              defaultModelSelection={defaultModelSelection}
              modelGroups={modelGroups}
              onOpenGlobalSettings={() => setGlobalSettingsOpen(true)}
              onSave={handleSave}
              onArchive={handleArchive}
              onCreate={handleCreate}
              prompt={prompt}
              onPromptChange={setPrompt}
              onRun={handleRun}
              runStatus={runStatus}
              runResult={runResult}
              runHistory={runHistory}
              schedules={schedules}
              scheduleHistory={scheduleHistory}
              hasConversation={(id) => conversations.some((c) => c.id === id)}
              onCreateSchedule={() => void handleCreateSchedule()}
              onToggleSchedule={(schedule) => void handleToggleSchedule(schedule)}
              onShowScheduleHistory={(schedule) => void handleShowScheduleHistory(schedule)}
              onDeleteSchedule={(schedule) => void handleDeleteSchedule(schedule)}
              onOpenScheduleThread={(conversationId) => selectConversation(conversationId)}
              schedulePrompt={schedulePrompt}
              onSchedulePromptChange={setSchedulePrompt}
              scheduleMinutes={scheduleMinutes}
              onScheduleMinutesChange={setScheduleMinutes}
            />
          ) : (
            <>
              <MessageThread
                messages={messages}
                hasActiveConversation={activeConversation !== null}
                bots={bots}
                pendingReply={pendingReply}
                typingLabel={typingLabel}
                threadNotice={threadNotice}
                emptyHintBotName={headerBot?.name ?? "this bot"}
                endRef={threadEndRef}
              />
              <Composer
                draft={draft}
                placeholder={composerPlaceholder}
                inputRef={composerInputRef}
                mentionQuery={mentions.mentionQuery}
                mentionSuggestions={mentions.mentionSuggestions}
                mentionIndex={mentions.mentionIndex}
                onSelectMention={mentions.selectMention}
                onInputChange={mentions.handleInputChange}
                onKeyDown={mentions.handleKeyDown}
                onNewSession={() => void handleNewConversation()}
                onSubmit={() => void handleSendMessage()}
              />
            </>
          )}
        </section>
      </div>

      <GlobalSettingsOverlay
        open={globalSettingsOpen}
        defaultModelSelection={defaultModelSelection}
        onSelectDefaultModel={setDefaultModelSelection}
        modelGroups={modelGroups}
        onSave={() => void saveAppSettings()}
        onClose={() => setGlobalSettingsOpen(false)}
      />

      <Dialog
        open={pendingDeleteBotId !== null}
        title="Delete bot?"
        onClose={() => setPendingDeleteBotId(null)}
      >
        <p className="dialog-body">
          This permanently deletes {botName(bots, pendingDeleteBotId)} and all of its threads, runs,
          and schedules. This cannot be undone.
        </p>
        <div className="dialog-actions">
          <button type="button" className="pill-button" onClick={() => setPendingDeleteBotId(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="pill-button pill-button-danger"
            onClick={() => {
              if (pendingDeleteBotId !== null) void handleDeleteBot(pendingDeleteBotId);
            }}
          >
            Delete
          </button>
        </div>
      </Dialog>
    </main>
  );
}
