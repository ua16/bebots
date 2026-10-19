import { useEffect, useState } from "react";
import type { BebotsPreloadApi } from "../shared/preload-api";
import "./styles.css";

declare global {
  interface Window {
    bebots?: BebotsPreloadApi;
  }
}

export function App() {
  const [platform, setPlatform] = useState<string>("unknown");

  useEffect(() => {
    setPlatform(window.bebots?.platform ?? "unavailable");
  }, []);

  return (
    <main className="app-main">
      <h1>bebots</h1>
      <p>Local-first multi-bot agent hub</p>
      <p>Platform: {platform}</p>
    </main>
  );
}
