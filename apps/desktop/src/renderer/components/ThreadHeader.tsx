import { Settings } from "lucide-react";
import type { BebotsBot } from "../../shared/preload-api";
import { BotAvatar } from "./avatar";

interface ThreadHeaderProps {
  readonly headerBot: BebotsBot | null;
  readonly headerTitle: string;
  readonly threadBotIds: readonly string[];
  readonly extraBots: readonly BebotsBot[];
  readonly participantsLabel: string;
  readonly settingsOpen: boolean;
  readonly onToggleSettings: () => void;
}

/** Thread identity bar shown across the chat and bot-settings views. */
export function ThreadHeader({
  headerBot,
  headerTitle,
  threadBotIds,
  extraBots,
  participantsLabel,
  settingsOpen,
  onToggleSettings,
}: ThreadHeaderProps) {
  return (
    <header className="chat-thread-head">
      <div className="thread-head-identity">
        <div className="thread-head-name-row">
          {headerBot !== null ? <BotAvatar avatar={headerBot.avatar} size={47} /> : null}
          <h2>{headerTitle}</h2>
        </div>
        <p className="muted thread-head-participants">
          {threadBotIds.length > 1 ? participantsLabel : "\u00a0"}
        </p>
      </div>
      {extraBots.length > 0 && (
        <div className="thread-extra-avatars" aria-hidden>
          {extraBots.map((bot) => (
            <BotAvatar key={bot.id} avatar={bot.avatar} size={24} />
          ))}
        </div>
      )}
      <button
        type="button"
        className={"icon-pill-button" + (settingsOpen ? " toggled" : "")}
        aria-label="Bot settings"
        title={headerBot ? `${headerBot.name} settings` : "Bot settings"}
        onClick={onToggleSettings}
      >
        <Settings size={21} strokeWidth={1.8} aria-hidden />
      </button>
    </header>
  );
}
