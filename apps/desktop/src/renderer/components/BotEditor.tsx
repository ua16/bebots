import type { BebotsBot } from "../../shared/preload-api";
import type { ApiModel, ApiRun, ApiSchedule, ApiScheduleOccurrence } from "../lib/api-types";
import type { ModelSelection } from "../lib/model-selection";
import { BOT_APP_DEFAULT_OPTION, ModelSelect } from "./ModelSelect";
import { SchedulePanel } from "./SchedulePanel";

interface BotEditorProps {
  readonly selected: BebotsBot | null;
  readonly name: string;
  readonly onNameChange: (value: string) => void;
  readonly description: string;
  readonly onDescriptionChange: (value: string) => void;
  readonly persona: string;
  readonly onPersonaChange: (value: string) => void;
  readonly modelSelection: ModelSelection;
  readonly onModelSelect: (selection: ModelSelection) => void;
  readonly defaultModelSelection: ModelSelection;
  readonly modelGroups: ReadonlyArray<[string, readonly ApiModel[]]>;
  readonly onOpenGlobalSettings: () => void;
  readonly onSave: () => void;
  readonly onArchive: () => void;
  readonly onCreate: () => void;
  // Run panel
  readonly prompt: string;
  readonly onPromptChange: (value: string) => void;
  readonly onRun: () => void;
  readonly runStatus: string | null;
  readonly runResult: string | null;
  readonly runHistory: readonly ApiRun[];
  // Schedules
  readonly schedules: readonly ApiSchedule[];
  readonly scheduleHistory: {
    readonly id: string;
    readonly occurrences: readonly ApiScheduleOccurrence[];
  } | null;
  readonly hasConversation: (id: string) => boolean;
  readonly onCreateSchedule: () => void;
  readonly onToggleSchedule: (schedule: ApiSchedule) => void;
  readonly onShowScheduleHistory: (schedule: ApiSchedule) => void;
  readonly onDeleteSchedule: (schedule: ApiSchedule) => void;
  readonly onOpenScheduleThread: (conversationId: string) => void;
  readonly schedulePrompt: string;
  readonly onSchedulePromptChange: (value: string) => void;
  readonly scheduleMinutes: string;
  readonly onScheduleMinutesChange: (value: string) => void;
}

/** Bot settings sheet: edit the selected bot, or the new-bot form. */
export function BotEditor({
  selected,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  persona,
  onPersonaChange,
  modelSelection,
  onModelSelect,
  defaultModelSelection,
  modelGroups,
  onOpenGlobalSettings,
  onSave,
  onArchive,
  onCreate,
  prompt,
  onPromptChange,
  onRun,
  runStatus,
  runResult,
  runHistory,
  schedules,
  scheduleHistory,
  hasConversation,
  onCreateSchedule,
  onToggleSchedule,
  onShowScheduleHistory,
  onDeleteSchedule,
  onOpenScheduleThread,
  schedulePrompt,
  onSchedulePromptChange,
  scheduleMinutes,
  onScheduleMinutesChange,
}: BotEditorProps) {
  const modelField = (
    <label className="settings-field">
      <span>Model</span>
      <ModelSelect
        selection={modelSelection}
        onSelect={onModelSelect}
        modelGroups={modelGroups}
        defaultOption={BOT_APP_DEFAULT_OPTION(defaultModelSelection)}
      />
    </label>
  );
  // Both branches render the same Name/Description/Persona fields.
  const identityFields = (
    <>
      <label className="settings-field">
        <span>Name</span>
        <input value={name} onChange={(e) => onNameChange(e.target.value)} />
      </label>
      <label className="settings-field">
        <span>Description</span>
        <input value={description} onChange={(e) => onDescriptionChange(e.target.value)} />
      </label>
      <label className="settings-field">
        <span>Persona</span>
        <textarea
          placeholder="Your bot's system prompt, this forms its AGENT.md"
          value={persona}
          onChange={(e) => onPersonaChange(e.target.value)}
        />
      </label>
    </>
  );

  return (
    <section className="bot-editor settings-scroll">
      <button type="button" className="pill-button" onClick={onOpenGlobalSettings}>
        Open Global Settings
      </button>

      {selected ? (
        <>
          {identityFields}
          {modelField}

          <div className="actions">
            <button type="button" className="pill-button" onClick={onSave}>
              Save
            </button>
            <button type="button" className="pill-button" onClick={onArchive}>
              Archive
            </button>
          </div>

          <label className="settings-field run-field">
            <span>Prompt</span>
            <div className="run-row">
              <input value={prompt} onChange={(e) => onPromptChange(e.target.value)} />
              <button type="button" className="pill-button" onClick={onRun}>
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
          <SchedulePanel
            schedules={schedules}
            hasConversation={hasConversation}
            history={scheduleHistory}
            onOpenThread={onOpenScheduleThread}
            prompt={schedulePrompt}
            onPromptChange={onSchedulePromptChange}
            minutes={scheduleMinutes}
            onMinutesChange={onScheduleMinutesChange}
            onCreate={onCreateSchedule}
            onToggle={onToggleSchedule}
            onShowHistory={onShowScheduleHistory}
            onDelete={onDeleteSchedule}
          />
        </>
      ) : (
        <>
          <h2>New bot</h2>
          {identityFields}
          {modelField}
          <div className="actions">
            <button type="button" className="pill-button" onClick={onCreate}>
              Create
            </button>
          </div>
        </>
      )}
    </section>
  );
}
