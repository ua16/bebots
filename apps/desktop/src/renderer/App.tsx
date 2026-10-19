import { useEffect, useState } from "react";
import type { BebotsPreloadApi, BebotsBot } from "../shared/preload-api";
import "./styles.css";

declare global {
  interface Window {
    bebots?: BebotsPreloadApi;
  }
}

export function App() {
  const [platform, setPlatform] = useState<string>("unknown");
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

  const bebots = window.bebots;
  const api = bebots?.bots;

  const refresh = async () => {
    if (!api) return;
    try {
      const list = await api.list(false);
      setBots(list);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    setPlatform(window.bebots?.platform ?? "unavailable");
    if (window.bebots?.workspace) {
      void window.bebots.workspace.getRoot().then(setWorkspaceRoot).catch(() => {});
    }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = bots.find((b) => b.id === selectedId) ?? null;

  useEffect(() => {
    if (selected) {
      setName(selected.name);
      setDescription(selected.description);
      setPersona(selected.persona);
    } else {
      setName("");
      setDescription("");
      setPersona("");
    }
  }, [selected]);

  const handleCreate = async () => {
    if (!api) return;
    setError(null);
    try {
      const bot = await api.create({ name: name || "New bot", description, persona });
      setSelectedId(bot.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleSave = async () => {
    if (!api || !selectedId) return;
    setError(null);
    try {
      await api.update(selectedId, { name, description, persona });
      await refresh();
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
      await refresh();
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
    } catch (e) {
      setError(String(e));
      setRunStatus("failed");
    }
  };

  return (
    <main className="app-main">
      <h1>bebots</h1>
      <p>Local-first multi-bot agent hub</p>
      <p>Platform: {platform}</p>
      {workspaceRoot && <p>Bots home: {workspaceRoot}</p>}

      <section className="bot-layout">
        <aside className="bot-list">
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
        </aside>

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
          {error && <p className="error">{error}</p>}
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
              </>
            ) : (
              <button type="button" onClick={handleCreate}>
                Create
              </button>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}
