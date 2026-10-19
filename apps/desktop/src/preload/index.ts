import { contextBridge, ipcRenderer } from "electron";
import type { BebotsPreloadApi } from "../shared/preload-api";

const api: BebotsPreloadApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
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
};

contextBridge.exposeInMainWorld("bebots", api);

export type { BebotsPreloadApi } from "../shared/preload-api";
