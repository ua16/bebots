import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Plus, Search } from "lucide-react";
import {
  UNASSIGNED_GROUP_ID,
  filterSessionGroups,
  type SessionGroup as SessionGroupType,
} from "../lib/sidebar-groups";
import { ContextMenu } from "./ContextMenu";
import { SessionGroup } from "./SessionGroup";

interface SidebarProps {
  readonly groups: readonly SessionGroupType[];
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly selectedId: string | null;
  readonly activeConversationId: string | null;
  readonly collapsedBots: ReadonlySet<string>;
  readonly expandedSessions: ReadonlySet<string>;
  readonly onToggleBotExpanded: (botId: string) => void;
  readonly onToggleShowAllSessions: (botId: string) => void;
  readonly onSelectConversation: (id: string, contextBotId?: string | null) => void;
  readonly onNewConversation: (withBotId?: string | null) => void;
  readonly onCreateBot: () => void;
  readonly onDeleteBot: (botId: string) => void;
  readonly onDeleteSession: (conversationId: string) => void;
}

/** Sidebar: search + new bot, bot-grouped session list with search filter. */
export function Sidebar({
  groups,
  search,
  onSearchChange,
  selectedId,
  activeConversationId,
  collapsedBots,
  expandedSessions,
  onToggleBotExpanded,
  onToggleShowAllSessions,
  onSelectConversation,
  onNewConversation,
  onCreateBot,
  onDeleteBot,
  onDeleteSession,
}: SidebarProps) {
  const visibleGroups = useMemo(() => filterSessionGroups(groups, search), [groups, search]);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    kind: "bot" | "session";
    id: string;
  } | null>(null);

  const openBotMenu = (event: ReactMouseEvent, botId: string) => {
    // The synthetic "other sessions" group is not a bot record; only its
    // individual sessions can be deleted.
    if (botId === UNASSIGNED_GROUP_ID) return;
    setMenu({ x: event.clientX, y: event.clientY, kind: "bot", id: botId });
  };

  const openSessionMenu = (event: ReactMouseEvent, conversationId: string) => {
    setMenu({ x: event.clientX, y: event.clientY, kind: "session", id: conversationId });
  };

  return (
    <aside className="chat-sidebar">
      <div className="chat-search">
        <Search size={19} strokeWidth={2.0} aria-hidden />
        <input
          type="search"
          placeholder="Search"
          value={search}
          aria-label="Search sessions"
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <button
          type="button"
          className="icon-pill-button"
          aria-label="New bot"
          title="New bot"
          onClick={onCreateBot}
        >
          <Plus size={20} strokeWidth={2.2} aria-hidden />
        </button>
      </div>

      <div className="chat-groups">
        {visibleGroups.map((group) => (
          <SessionGroup
            key={group.botId}
            group={group}
            expanded={!collapsedBots.has(group.botId)}
            showAllSessions={expandedSessions.has(group.botId)}
            selected={group.botId === selectedId}
            activeConversationId={activeConversationId}
            onToggleExpanded={() => onToggleBotExpanded(group.botId)}
            onToggleShowAllSessions={() => onToggleShowAllSessions(group.botId)}
            onSelectConversation={onSelectConversation}
            onNewConversation={onNewConversation}
            onBotContextMenu={openBotMenu}
            onSessionContextMenu={openSessionMenu}
          />
        ))}
        {visibleGroups.length === 0 && <p className="session-empty">No conversations yet</p>}
      </div>

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.kind === "bot"
              ? [{ label: "Delete bot", danger: true, onSelect: () => onDeleteBot(menu.id) }]
              : [
                  {
                    label: "Delete session",
                    danger: true,
                    onSelect: () => onDeleteSession(menu.id),
                  },
                ]
          }
        />
      )}
    </aside>
  );
}
