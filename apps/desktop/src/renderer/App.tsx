import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AttachmentMarker,
  type BotAvatar,
  formFromWire,
  isDesktopRenderableForm,
} from "@bebots/domain";
import type { Form } from "@bebots/domain";
import { apiRequest } from "./apiClient";
import type { ApiEndpoint } from "./apiClient";
import type { BebotsPreloadApi, BebotsBot } from "../shared/preload-api";
import type {
  ApiConversation,
  ApiMessage,
  ApiModel,
  ApiSchedule,
  ApiScheduleOccurrence,
} from "./lib/api-types";
import { subscribeLiveEvents, type LiveEvent } from "./lib/live-events";
import {
  appDefaultToSelection,
  botModelToSelection,
  groupModelsByProvider,
  selectionToApiModel,
  type ModelSelection,
} from "./lib/model-selection";
import { UNASSIGNED_GROUP_ID, groupSidebarSessions, type SessionGroup } from "./lib/sidebar-groups";
import { botName } from "./lib/bot-name";
import {
  deleteUploadedAttachment,
  downloadAttachment,
  type StagedAttachment,
  type UploadedAttachment,
  uploadAttachment,
  validateAttachmentFile,
} from "./lib/attachments";
import { Sidebar } from "./components/Sidebar";
import { ThreadHeader } from "./components/ThreadHeader";
import { GlobalSettingsOverlay } from "./components/GlobalSettingsOverlay";
import { Dialog } from "./components/Dialog";
import { ToastStack, type ToastItem } from "./components/Toast";
import { BotEditor } from "./components/BotEditor";
import { MessageThread } from "./components/MessageThread";
import { Composer } from "./components/Composer";
import {
  UserInputCard,
  answersFromComposerDraft,
  formAllowsComposerAnswer,
} from "./components/UserInputCard";
import { useMentions } from "./hooks/useMentions";
import "./styles.css";

interface PendingUserInput {
  readonly runId: string;
  readonly form: Form;
  readonly conversationId: string;
  readonly afterCreatedAt: number;
}

declare global {
  interface Window {
    bebots?: BebotsPreloadApi;
  }
}

const NEW_BOT_FORM_AVATAR: BotAvatar = { face: "face-0", color: 0, shape: "circle" };

export function App() {
  const [platform, setPlatform] = useState<string>("unknown");
  const [endpoint, setEndpoint] = useState<ApiEndpoint | null>(null);
  const [bots, setBots] = useState<readonly BebotsBot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [avatar, setAvatar] = useState<BotAvatar>(NEW_BOT_FORM_AVATAR);
  const [avatarCustomized, setAvatarCustomized] = useState(false);
  const draftRef = useRef({
    name: "",
    description: "",
    persona: "",
    avatar: NEW_BOT_FORM_AVATAR,
    botModelSelection: { kind: "app-default" } as ModelSelection,
  });
  const botPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncedBotIdRef = useRef<string | null>(null);
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const pushError = useCallback((message: string) => {
    setToasts((prev) => [...prev, { id: crypto.randomUUID(), message, tone: "error" }]);
  }, []);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
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
  const [stagedFiles, setStagedFiles] = useState<readonly StagedAttachment[]>([]);
  const [sendingMessage, setSendingMessage] = useState(false);
  // Sidebar: bot-group expansion (absent = expanded).
  const [collapsedBots, setCollapsedBots] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");
  // Bot groups whose session list is fully expanded (beyond the 5 most recent).
  const [expandedSessions, setExpandedSessions] = useState<ReadonlySet<string>>(new Set());
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
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
  const [pendingUserInput, setPendingUserInput] = useState<PendingUserInput | null>(null);
  const [userInputBusy, setUserInputBusy] = useState(false);
  const [threadNotice, setThreadNotice] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const scheduleHistoryIdRef = useRef<string | null>(null);
  const runWatchersRef = useRef(
    new Map<string, (run: Extract<LiveEvent, { kind: "run.updated" }>["run"]) => void>(),
  );
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
      pushError(String(e));
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
      pushError(String(e));
    }
  }, [endpoint, pushError]);

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

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    scheduleHistoryIdRef.current = scheduleHistory?.id ?? null;
  }, [scheduleHistory?.id]);

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
      pushError(String(e));
    }
  };

  const selectConversation = (id: string, contextBotId?: string | null) => {
    activeIdRef.current = id;
    setActiveConversationId(id);
    setMessages([]);
    setPendingReply(false);
    setPendingUserInput(null);
    setThreadNotice(null);
    setStagedFiles([]);
    setView("chat");
    if (contextBotId !== undefined) setSelectedId(contextBotId);
    void refreshMessages(id);
  };

  const hydrateUserInput = async (
    runId: string,
    conversationId: string,
    afterCreatedAt: number,
    endpointAt: ApiEndpoint,
  ) => {
    try {
      const form = await apiRequest(
        endpointAt,
        `/api/v1/runs/${encodeURIComponent(runId)}/input`,
        (c) => c.runs.getRunInput({ params: { id: runId } }),
      );
      const domainForm = formFromWire(form);
      if (!isDesktopRenderableForm(domainForm)) {
        await apiRequest(
          endpointAt,
          `/api/v1/runs/${encodeURIComponent(runId)}/input/dismiss`,
          (c) => c.runs.dismissRunInput({ params: { id: runId } }),
        );
        setPendingReply(false);
        setThreadNotice("This question uses a form shape the desktop app can't show yet.");
        return;
      }
      setPendingReply(false);
      setPendingUserInput({ runId, form: domainForm, conversationId, afterCreatedAt });
    } catch (e) {
      setPendingReply(false);
      pushError(`Could not load the bot's question: ${String(e)}`);
    }
  };

  /**
   * Wait for a run via live SSE (`run.updated`). Branches when the run needs
   * input or reaches a terminal status.
   */
  const watchRunForInput = async (
    runId: string,
    conversationId: string,
    afterCreatedAt: number,
    endpointAt: ApiEndpoint,
  ) => {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        runWatchersRef.current.delete(runId);
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        setPendingReply(false);
        setThreadNotice(
          "No reply yet — the run may still be in flight or failed. Check run history.",
        );
        finish();
      }, 240_000);

      runWatchersRef.current.set(runId, (run) => {
        void (async () => {
          if (activeIdRef.current !== conversationId) {
            finish();
            return;
          }
          if (run.status === "awaiting_input") {
            await hydrateUserInput(runId, conversationId, afterCreatedAt, endpointAt);
            finish();
            return;
          }
          if (
            run.status === "succeeded" ||
            run.status === "failed" ||
            run.status === "cancelled" ||
            run.status === "timed_out"
          ) {
            setPendingReply(false);
            await refreshMessages(conversationId);
            finish();
          }
        })();
      });
    });
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
      pushError(String(e));
      return null;
    }
  };

  const replyPendingUserInput = (answers: Record<string, string | string[]>) => {
    if (!endpoint || userInputBusy || pendingUserInput === null) return;
    const { runId, conversationId, afterCreatedAt } = pendingUserInput;
    setUserInputBusy(true);
    void apiRequest(endpoint, `/api/v1/runs/${encodeURIComponent(runId)}/input/reply`, (c) =>
      c.runs.replyRunInput({
        params: { id: runId },
        payload: { answers },
      }),
    )
      .then(() => {
        setPendingUserInput(null);
        setDraft("");
        mentions.clearMentions();
        setPendingReply(true);
        return refreshMessages(conversationId).then(() =>
          watchRunForInput(runId, conversationId, afterCreatedAt, endpoint),
        );
      })
      .catch((e) => pushError(String(e)))
      .finally(() => setUserInputBusy(false));
  };

  const addStagedFiles = useCallback(
    (files: readonly File[]) => {
      const accepted: StagedAttachment[] = [];
      for (const file of files) {
        const error = validateAttachmentFile(file);
        if (error) {
          pushError(error);
          continue;
        }
        accepted.push({ id: crypto.randomUUID(), file, progress: null });
      }
      if (accepted.length === 0) return;
      setStagedFiles((prev) => [...prev, ...accepted]);
    },
    [pushError],
  );

  const removeStagedFile = useCallback((id: string) => {
    setStagedFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleDownloadAttachment = useCallback(
    (marker: AttachmentMarker) => {
      if (!endpoint) return;
      void downloadAttachment(
        endpoint,
        marker.conversationId,
        marker.botId,
        marker.savedName,
        marker.fileName,
      ).catch((e) => pushError(String(e)));
    },
    [endpoint, pushError],
  );

  const handleSendMessage = async () => {
    if (!endpoint || sendingMessage) return;

    if (pendingUserInput !== null) {
      if (draft.trim().length === 0) return;
      if (!formAllowsComposerAnswer(pendingUserInput.form)) return;
      const answers = answersFromComposerDraft(pendingUserInput.form, draft);
      if (answers === null) return;
      replyPendingUserInput(answers);
      return;
    }

    const text = draft;
    const batch = stagedFiles;
    if (text.trim().length === 0 && batch.length === 0) return;

    setSendingMessage(true);
    const uploaded: UploadedAttachment[] = [];
    let conversationId = activeConversationId;
    try {
      // Sending from the empty state (a bot is picked but no thread open) starts
      // a fresh thread with that bot, then posts the message.
      if (conversationId === null) {
        conversationId = await createConversationWith(selectedId);
        if (conversationId === null) return;
        activeIdRef.current = conversationId;
        setActiveConversationId(conversationId);
        setMessages([]);
      }

      const threadId = conversationId;
      for (const item of batch) {
        setStagedFiles((prev) =>
          prev.map((f) => (f.id === item.id ? { ...f, progress: 0 } : f)),
        );
        const stored = await uploadAttachment(endpoint, threadId, item.file, (ratio) => {
          setStagedFiles((prev) =>
            prev.map((f) => (f.id === item.id ? { ...f, progress: ratio } : f)),
          );
        });
        uploaded.push(stored);
      }

      const reply = await apiRequest(
        endpoint,
        `/api/v1/conversations/${encodeURIComponent(threadId)}/messages`,
        (c) =>
          c.conversations.postMessage({
            params: { id: threadId },
            payload: {
              content: text,
              ...(uploaded.length > 0 && {
                attachments: uploaded.map((a) => ({
                  savedName: a.savedName,
                  fileName: a.fileName,
                  size: a.size,
                  contentType: a.contentType,
                  botId: a.botId,
                })),
              }),
            },
          }),
      );
      const sentIds = new Set(batch.map((b) => b.id));
      setStagedFiles((prev) => prev.filter((f) => !sentIds.has(f.id)));
      setDraft("");
      mentions.clearMentions();
      setThreadNotice(null);
      await refreshMessages(threadId);
      if (reply.runId !== null) {
        setPendingReply(true);
        void watchRunForInput(reply.runId, threadId, reply.message.createdAt, endpoint);
      } else {
        setPendingReply(false);
      }
    } catch (e) {
      const rollbackId = conversationId;
      if (rollbackId !== null && uploaded.length > 0) {
        await Promise.all(
          uploaded.map((a) =>
            deleteUploadedAttachment(endpoint, rollbackId, a.botId, a.savedName).catch(
              () => undefined,
            ),
          ),
        );
      }
      setStagedFiles((prev) => prev.map((f) => ({ ...f, progress: null })));
      pushError(String(e));
    } finally {
      setSendingMessage(false);
    }
  };

  const handleNewConversation = async (withBotId?: string | null) => {
    const botId = withBotId === undefined ? selectedId : withBotId;
    const created = await createConversationWith(botId);
    if (created === null) return;
    selectConversation(created, botId);
  };

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
      pushError(String(e));
    }
  }, [endpoint, selectedId, pushError]);

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
      pushError(String(e));
    }
  }, [endpoint, scheduleHistory?.id, pushError]);

  useEffect(() => {
    if (selected) {
      void refreshSchedules();
    } else {
      setSchedules([]);
      setScheduleHistory(null);
    }
  }, [selected, refreshSchedules]);

  // Live SSE replaces conversation/schedule/message polling and drives
  // watchRunForInput via run.updated frames.
  useEffect(() => {
    if (!endpoint) return;
    const ac = new AbortController();
    const onEvent = (event: LiveEvent) => {
      if (event.kind === "conversation.updated") {
        void refreshConversations();
        if (
          event.reason === "message" &&
          activeIdRef.current !== null &&
          event.conversationId === activeIdRef.current
        ) {
          void refreshMessages(event.conversationId);
        }
        return;
      }
      if (event.kind === "schedule.updated") {
        if (selectedIdRef.current !== null && event.botId === selectedIdRef.current) {
          void refreshSchedules();
        }
        if (scheduleHistoryIdRef.current === event.scheduleId) {
          void refreshScheduleHistory();
        }
        return;
      }
      if (event.kind === "activity" && event.activity.entityType === "schedule") {
        void refreshSchedules();
        void refreshScheduleHistory();
        return;
      }
      if (event.kind === "run.updated") {
        const watcher = runWatchersRef.current.get(event.run.id);
        if (watcher) watcher(event.run);
        const conversationId = event.run.conversationId;
        if (
          conversationId &&
          activeIdRef.current === conversationId &&
          (event.run.status === "succeeded" ||
            event.run.status === "failed" ||
            event.run.status === "cancelled" ||
            event.run.status === "timed_out" ||
            event.run.status === "awaiting_input")
        ) {
          void refreshMessages(conversationId);
        }
      }
    };
    void subscribeLiveEvents(endpoint, onEvent, ac.signal);
    return () => ac.abort();
    // refreshMessages is stable enough via activeIdRef; listing deps that
    // recreate every render would thrash the SSE connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, refreshConversations, refreshSchedules, refreshScheduleHistory]);

  // Load draft when the selected bot changes — not on every bots[] refresh, so
  // autosave updates do not clobber in-progress edits.
  useEffect(() => {
    if (!selectedId) {
      syncedBotIdRef.current = null;
      const emptyModel = { kind: "app-default" } as ModelSelection;
      setName("");
      setDescription("");
      setPersona("");
      setAvatar(NEW_BOT_FORM_AVATAR);
      setAvatarCustomized(false);
      setBotModelSelection(emptyModel);
      draftRef.current = {
        name: "",
        description: "",
        persona: "",
        avatar: NEW_BOT_FORM_AVATAR,
        botModelSelection: emptyModel,
      };
      return;
    }
    if (syncedBotIdRef.current === selectedId) return;
    const bot = bots.find((b) => b.id === selectedId);
    if (!bot) return;
    syncedBotIdRef.current = selectedId;
    const modelSelection = botModelToSelection(bot.model);
    setName(bot.name);
    setDescription(bot.description);
    setPersona(bot.persona);
    setAvatar(bot.avatar);
    setAvatarCustomized(false);
    setBotModelSelection(modelSelection);
    draftRef.current = {
      name: bot.name,
      description: bot.description,
      persona: bot.persona,
      avatar: bot.avatar,
      botModelSelection: modelSelection,
    };
  }, [selectedId, bots]);

  // Group the model catalog by provider (stable, response order) for optgroups.
  const modelGroups: ReadonlyArray<[string, readonly ApiModel[]]> = useMemo(
    () => groupModelsByProvider(models),
    [models],
  );

  const persistBot = useCallback(async () => {
    if (!api || !selectedId) return;
    const draft = draftRef.current;
    try {
      const updated = await api.update(selectedId, {
        name: draft.name,
        description: draft.description,
        persona: draft.persona,
        model: selectionToApiModel(draft.botModelSelection),
        avatar: draft.avatar,
      });
      setBots((prev) =>
        prev.map((b) => (b.id === updated.id ? { ...updated, homePath: b.homePath } : b)),
      );
    } catch (e) {
      pushError(String(e));
    }
  }, [api, selectedId, pushError]);

  const schedulePersistBot = useCallback(() => {
    if (!selectedId) return;
    if (botPersistTimerRef.current) clearTimeout(botPersistTimerRef.current);
    botPersistTimerRef.current = setTimeout(() => {
      botPersistTimerRef.current = null;
      void persistBot();
    }, 400);
  }, [selectedId, persistBot]);

  useEffect(() => {
    return () => {
      if (botPersistTimerRef.current) clearTimeout(botPersistTimerRef.current);
    };
  }, []);

  const handleDraftStringChange = useCallback(
    (field: "name" | "description" | "persona", value: string) => {
      if (field === "name") setName(value);
      else if (field === "description") setDescription(value);
      else setPersona(value);
      draftRef.current = { ...draftRef.current, [field]: value };
      schedulePersistBot();
    },
    [schedulePersistBot],
  );

  const handleAvatarChange = useCallback((value: BotAvatar) => {
    setAvatar(value);
    setAvatarCustomized(true);
    draftRef.current = { ...draftRef.current, avatar: value };
  }, []);

  const handleAvatarDialogClose = useCallback(() => {
    if (!selectedId) return;
    if (botPersistTimerRef.current) {
      clearTimeout(botPersistTimerRef.current);
      botPersistTimerRef.current = null;
    }
    void persistBot();
  }, [selectedId, persistBot]);

  const handleBotModelSelect = useCallback(
    (selection: ModelSelection) => {
      setBotModelSelection(selection);
      draftRef.current = { ...draftRef.current, botModelSelection: selection };
      if (!selectedId) return;
      if (botPersistTimerRef.current) {
        clearTimeout(botPersistTimerRef.current);
        botPersistTimerRef.current = null;
      }
      void persistBot();
    },
    [selectedId, persistBot],
  );

  const saveAppSettings = async () => {
    if (!endpoint) return;
    try {
      const s = await apiRequest(endpoint, "/api/v1/settings", (c) =>
        c.settings.putSettings({
          payload: { defaultModel: selectionToApiModel(defaultModelSelection) },
        }),
      );
      setDefaultModelSelection(appDefaultToSelection(s.defaultModel));
    } catch (e) {
      pushError(String(e));
    }
  };

  const handleCreate = async () => {
    if (!api) return;
    try {
      const bot = await api.create({
        name: name || "New bot",
        description,
        persona,
        model: selectionToApiModel(botModelSelection),
        ...(avatarCustomized ? { avatar } : {}),
      });
      setSelectedId(bot.id);
      setView("bot-settings");
      await refreshBots();
    } catch (e) {
      pushError(String(e));
    }
  };

  const handleCreateBot = async () => {
    if (!api) return;
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
      pushError(String(e));
    }
  };

  const handleArchive = async () => {
    if (!api || !selectedId) return;
    try {
      await api.archive(selectedId);
      setSelectedId(null);
      await refreshBots();
    } catch (e) {
      pushError(String(e));
    }
  };

  const handleRun = async () => {
    if (!api || !selectedId) return;
    setRunStatus("running");
    try {
      const run = await bebots!.runs.start({ botId: selectedId, prompt: prompt || "Hello" });
      const final = await bebots!.runs.await(run.id, 120000);
      setRunStatus(final?.status ?? run.status);
      setRunResult(final?.summary ?? null);
    } catch (e) {
      pushError(String(e));
      setRunStatus("failed");
    }
  };

  const handleCreateSchedule = async () => {
    if (!endpoint || !selectedId) return;
    const minutes = Number(scheduleMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) {
      pushError("Interval must be at least 1 minute");
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
      pushError(String(e));
    }
  };

  const handleToggleSchedule = async (schedule: ApiSchedule) => {
    if (!endpoint) return;
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
      pushError(String(e));
    }
  };

  const handleDeleteSchedule = async (schedule: ApiSchedule) => {
    if (!endpoint) return;
    try {
      await apiRequest(endpoint, `/api/v1/schedules/${encodeURIComponent(schedule.id)}`, (c) =>
        c.schedules.deleteSchedule({ params: { id: schedule.id } }),
      );
      setScheduleHistory(null);
      await refreshSchedules();
    } catch (e) {
      pushError(String(e));
    }
  };

  // Deleting a bot hard-deletes it with all tied data (threads, runs,
  // schedules); clear whatever UI state pointed at it.
  const handleDeleteBot = async (botId: string) => {
    if (!endpoint) return;
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
      pushError(String(e));
    }
  };

  const handleDeleteConversation = async (conversationId: string) => {
    if (!endpoint) return;
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
      pushError(String(e));
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
      pushError(String(e));
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
  const extraBots = threadBotIds
    .filter((id) => id !== headerBotId)
    .map((id) => bots.find((b) => b.id === id))
    .filter((b): b is BebotsBot => b !== undefined);
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
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

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
        <section
          className="chat-main"
          onDragOver={(e) => {
            if (pendingUserInput !== null || view !== "chat") return;
            e.preventDefault();
          }}
          onDrop={(e) => {
            if (pendingUserInput !== null || view !== "chat") return;
            e.preventDefault();
            const files = [...(e.dataTransfer?.files ?? [])];
            if (files.length > 0) addStagedFiles(files);
          }}
        >
          <ThreadHeader
            headerBot={headerBot}
            headerTitle={headerTitle}
            threadBotIds={threadBotIds}
            extraBots={extraBots}
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
              onNameChange={(value) => handleDraftStringChange("name", value)}
              description={description}
              onDescriptionChange={(value) => handleDraftStringChange("description", value)}
              persona={persona}
              onPersonaChange={(value) => handleDraftStringChange("persona", value)}
              avatar={avatar}
              onAvatarChange={handleAvatarChange}
              onAvatarDialogClose={handleAvatarDialogClose}
              modelSelection={botModelSelection}
              onModelSelect={handleBotModelSelect}
              defaultModelSelection={defaultModelSelection}
              modelGroups={modelGroups}
              onOpenGlobalSettings={() => setGlobalSettingsOpen(true)}
              onArchive={handleArchive}
              onCreate={handleCreate}
              prompt={prompt}
              onPromptChange={setPrompt}
              onRun={handleRun}
              runStatus={runStatus}
              runResult={runResult}
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
                pendingReply={pendingReply && pendingUserInput === null}
                typingLabel={typingLabel}
                threadNotice={threadNotice}
                emptyHintBotName={headerBot?.name ?? "this bot"}
                endRef={threadEndRef}
                onDownloadAttachment={handleDownloadAttachment}
              />
              {pendingUserInput !== null && (
                <UserInputCard
                  form={pendingUserInput.form}
                  busy={userInputBusy}
                  onDismiss={() => {
                    if (!endpoint || userInputBusy) return;
                    const { runId, conversationId } = pendingUserInput;
                    setUserInputBusy(true);
                    void apiRequest(
                      endpoint,
                      `/api/v1/runs/${encodeURIComponent(runId)}/input/dismiss`,
                      (c) => c.runs.dismissRunInput({ params: { id: runId } }),
                    )
                      .then(() => {
                        setPendingUserInput(null);
                        setDraft("");
                        setPendingReply(false);
                        return refreshMessages(conversationId);
                      })
                      .catch((e) => pushError(String(e)))
                      .finally(() => setUserInputBusy(false));
                  }}
                  onSubmit={replyPendingUserInput}
                />
              )}
              <Composer
                draft={draft}
                placeholder={
                  pendingUserInput !== null && formAllowsComposerAnswer(pendingUserInput.form)
                    ? "Type your own answer…"
                    : composerPlaceholder
                }
                inputRef={composerInputRef}
                mentionQuery={mentions.mentionQuery}
                mentionSuggestions={mentions.mentionSuggestions}
                mentionIndex={mentions.mentionIndex}
                onSelectMention={mentions.selectMention}
                onInputChange={mentions.handleInputChange}
                onKeyDown={mentions.handleKeyDown}
                onNewSession={() => void handleNewConversation()}
                onSubmit={() => void handleSendMessage()}
                inputDisabled={
                  userInputBusy ||
                  (pendingUserInput !== null && !formAllowsComposerAnswer(pendingUserInput.form))
                }
                sendDisabled={
                  sendingMessage ||
                  userInputBusy ||
                  (pendingUserInput !== null && !formAllowsComposerAnswer(pendingUserInput.form))
                }
                stagedFiles={pendingUserInput !== null ? [] : stagedFiles}
                onAddFiles={pendingUserInput !== null ? undefined : addStagedFiles}
                onRemoveFile={removeStagedFile}
                stagingLocked={sendingMessage}
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
