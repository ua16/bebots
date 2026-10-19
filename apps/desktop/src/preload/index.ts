import { contextBridge } from "electron";
import type { BebotsPreloadApi } from "../shared/preload-api";

/**
 * Narrow, typed preload bridge. The renderer must not receive arbitrary
 * Node or Electron APIs. Add entries here deliberately and document them.
 */
const api: BebotsPreloadApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
};

contextBridge.exposeInMainWorld("bebots", api);

export type { BebotsPreloadApi } from "../shared/preload-api";
