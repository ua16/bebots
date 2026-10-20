import { contextBridge, ipcRenderer } from "electron";
import type { BebotsPreloadApi } from "../shared/preload-api";

const api: BebotsPreloadApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  workspace: {
    getRoot: () => ipcRenderer.invoke("bebots:workspace:root") as Promise<string>,
  },
  apiEndpoint: () =>
    ipcRenderer.invoke("bebots:api:endpoint") as Promise<{
      url: string;
      token: string;
    } | null>,
  bots: {
    list: (includeArchived) =>
      ipcRenderer.invoke("bebots:bots:list", includeArchived) as Promise<
        readonly import("../shared/preload-api").BebotsBot[]
      >,
    get: (id) => ipcRenderer.invoke("bebots:bots:get", id),
    create: (input) => ipcRenderer.invoke("bebots:bots:create", input),
    update: (id, input) => ipcRenderer.invoke("bebots:bots:update", id, input),
    archive: (id) => ipcRenderer.invoke("bebots:bots:archive", id),
  },
  runs: {
    start: (input) => ipcRenderer.invoke("bebots:runs:start", input),
    get: (id) => ipcRenderer.invoke("bebots:runs:get", id),
    list: (options) => ipcRenderer.invoke("bebots:runs:list", options),
    cancel: (id) => ipcRenderer.invoke("bebots:runs:cancel", id),
    events: (id) => ipcRenderer.invoke("bebots:runs:events", id),
    await: (id, timeoutMs) => ipcRenderer.invoke("bebots:runs:await", id, timeoutMs),
  },
};

contextBridge.exposeInMainWorld("bebots", api);

export type { BebotsPreloadApi } from "../shared/preload-api";
