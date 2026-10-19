import { Effect } from "effect";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BotId } from "@bebots/domain";
import type { BotWorkspace } from "@bebots/application";
import { WorkspaceError } from "@bebots/application";

export interface CreateWorkspaceOptions {
  readonly root: string;
}

export function createNodeBotWorkspace(options: CreateWorkspaceOptions): BotWorkspace {
  const botsRoot = join(options.root, "bots");

  const assertSafeId = (botId: BotId): void => {
    if (
      botId.length === 0 ||
      botId === "." ||
      botId === ".." ||
      botId.includes("/") ||
      botId.includes("\\") ||
      botId.includes("\0")
    ) {
      throw new WorkspaceError("Unsafe bot id");
    }
  };

  const ensureDir = (path: string): void => {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  };

  return {
    root: botsRoot,
    ensureHome: (botId: BotId) =>
      Effect.try({
        try: () => {
          assertSafeId(botId);
          const home = join(botsRoot, botId);
          ensureDir(home);
          ensureDir(join(home, ".opencode"));
          ensureDir(join(home, ".opencode", "skills"));
          ensureDir(join(home, "notes"));
          ensureDir(join(home, "memory"));
          ensureDir(join(home, "logs"));
          return home;
        },
        catch: (cause) => new WorkspaceError("Failed to create bot home directory", cause),
      }),
    writePersona: (botId: BotId, persona: string) =>
      Effect.try({
        try: () => {
          assertSafeId(botId);
          const home = join(botsRoot, botId);
          ensureDir(home);
          writeFileSync(join(home, "AGENTS.md"), persona, "utf8");
        },
        catch: (cause) => new WorkspaceError("Failed to write persona", cause),
      }),
    homePath: (botId: BotId) => {
      assertSafeId(botId);
      return join(botsRoot, botId);
    },
  };
}
