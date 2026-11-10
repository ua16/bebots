import { useMemo } from "react";
import { Plus, Search } from "lucide-react";
import { filterSessionGroups, type SessionGroup as SessionGroupType } from "../lib/sidebar-groups";
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
}: SidebarProps) {
  const visibleGroups = useMemo(() => filterSessionGroups(groups, search), [groups, search]);

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
          />
        ))}
        {visibleGroups.length === 0 && <p className="session-empty">No conversations yet</p>}
      </div>
    </aside>
  );
}
