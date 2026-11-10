import type { ApiSchedule, ApiScheduleOccurrence } from "../lib/api-types";
import { describeTrigger } from "../lib/schedule-format";

interface SchedulePanelProps {
  readonly schedules: readonly ApiSchedule[];
  readonly hasConversation: (id: string) => boolean;
  readonly history: {
    readonly id: string;
    readonly occurrences: readonly ApiScheduleOccurrence[];
  } | null;
  readonly onCreate: () => void;
  readonly onToggle: (schedule: ApiSchedule) => void;
  readonly onShowHistory: (schedule: ApiSchedule) => void;
  readonly onDelete: (schedule: ApiSchedule) => void;
  readonly onOpenThread: (conversationId: string) => void;
  readonly prompt: string;
  readonly onPromptChange: (value: string) => void;
  readonly minutes: string;
  readonly onMinutesChange: (value: string) => void;
}

/** Schedules for the selected bot: list with controls, occurrence history, and a create form. */
export function SchedulePanel({
  schedules,
  hasConversation,
  history,
  onOpenThread,
  prompt,
  onPromptChange,
  minutes,
  onMinutesChange,
  onCreate,
  onToggle,
  onShowHistory,
  onDelete,
}: SchedulePanelProps) {
  return (
    <div className="schedule-panel">
      <h3>Schedules</h3>
      <ul className="schedule-list">
        {schedules.length === 0 && <li className="muted">No scheduled runs</li>}
        {schedules.map((schedule) => (
          <li key={schedule.id} className={"card-row" + (schedule.enabled ? "" : " muted")}>
            <div className="schedule-row">
              <span className="schedule-trigger">{describeTrigger(schedule.trigger)}</span>
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
              <button type="button" onClick={() => onToggle(schedule)}>
                {schedule.enabled ? "Pause" : "Enable"}
              </button>
              <button type="button" onClick={() => onShowHistory(schedule)}>
                History
              </button>
              <button type="button" onClick={() => onDelete(schedule)}>
                Delete
              </button>
              {schedule.conversationId && hasConversation(schedule.conversationId) && (
                <button type="button" onClick={() => onOpenThread(schedule.conversationId!)}>
                  Open thread
                </button>
              )}
            </div>
            {history?.id === schedule.id && (
              <ul className="schedule-occurrences">
                {history.occurrences.length === 0 && <li className="muted">No occurrences yet</li>}
                {history.occurrences.map((occ) => (
                  <li key={occ.id}>
                    <code>{occ.status}</code> {new Date(occ.scheduledFor).toLocaleString()}
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
            value={prompt}
            placeholder="Prompt to run on schedule"
            onChange={(e) => onPromptChange(e.target.value)}
          />
        </label>
        <label>
          Every (minutes)
          <input
            value={minutes}
            inputMode="numeric"
            onChange={(e) => onMinutesChange(e.target.value)}
          />
        </label>
        <button type="button" className="pill-button" onClick={onCreate}>
          Schedule run
        </button>
      </div>
    </div>
  );
}
