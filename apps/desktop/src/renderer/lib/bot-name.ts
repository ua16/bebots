import type { BebotsBot } from "../../shared/preload-api";

export function botName(bots: readonly BebotsBot[], id: string | null | undefined): string {
  if (id === null || id === undefined) return "Bot";
  return bots.find((b) => b.id === id)?.name ?? id;
}
