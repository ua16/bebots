import type { MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { UNASSIGNED_GROUP_ID, type SessionGroup } from "../lib/sidebar-groups";
import { BotAvatar } from "./avatar";

interface SessionGroupProps {
  readonly group: SessionGroup;
  readonly expanded: boolean;
  readonly showAllSessions: boolean;
  readonly selected: boolean;
  readonly activeConversationId: string | null;
  readonly onToggleExpanded: () => void;
  readonly onToggleShowAllSessions: () => void;
  readonly onSelectConversation: (id: string, contextBotId?: string | null) => void;
  readonly onNewConversation: (botId: string | null) => void;
  readonly onBotContextMenu: (event: ReactMouseEvent, botId: string) => void;
  readonly onSessionContextMenu: (event: ReactMouseEvent, conversationId: string) => void;
}

export function SessionGroup({
  group,
  expanded,
  showAllSessions,
  selected,
  activeConversationId,
  onToggleExpanded,
  onToggleShowAllSessions,
  onSelectConversation,
  onNewConversation,
  onBotContextMenu,
  onSessionContextMenu,
}: SessionGroupProps) {
  return (
    <div className="session-group">
      <button
        type="button"
        className={"bot-row" + (selected ? " bot-row-selected" : "")}
        aria-expanded={expanded}
        aria-controls={`sessions-${group.botId}`}
        onClick={onToggleExpanded}
        onContextMenu={(e) => {
          e.preventDefault();
          onBotContextMenu(e, group.botId);
        }}
      >
        <BotAvatar id={group.botId === UNASSIGNED_GROUP_ID ? null : group.botId} size={39} />
        <span className="bot-row-name">{group.name}</span>
        {expanded ? (
          <ChevronUp size={19} strokeWidth={2.4} aria-hidden />
        ) : (
          <ChevronDown size={19} strokeWidth={2.4} aria-hidden />
        )}
      </button>
      {expanded && (
        <ul id={`sessions-${group.botId}`} className="session-pills">
          <li>
            <button
              type="button"
              className="session-pill session-pill-new"
              onClick={() =>
                onNewConversation(group.botId === UNASSIGNED_GROUP_ID ? null : group.botId)
              }
            >
              + New session
            </button>
          </li>
          {(showAllSessions ? group.sessions : group.sessions.slice(0, 5)).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={"session-pill" + (c.id === activeConversationId ? " selected" : "")}
                onClick={() =>
                  group.botId === UNASSIGNED_GROUP_ID
                    ? onSelectConversation(c.id)
                    : onSelectConversation(c.id, group.botId)
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  onSessionContextMenu(e, c.id);
                }}
              >
                {c.title || c.id}
              </button>
            </li>
          ))}
          {!showAllSessions && group.sessions.length > 5 && (
            <li>
              <button
                type="button"
                className="session-pill session-pill-more"
                onClick={onToggleShowAllSessions}
              >
                Show {group.sessions.length - 5} more
              </button>
            </li>
          )}
          {showAllSessions && group.sessions.length > 5 && (
            <li>
              <button
                type="button"
                className="session-pill session-pill-more"
                onClick={onToggleShowAllSessions}
              >
                Show less
              </button>
            </li>
          )}
          {group.sessions.length === 0 && <li className="session-empty">No sessions yet</li>}
        </ul>
      )}
    </div>
  );
}
