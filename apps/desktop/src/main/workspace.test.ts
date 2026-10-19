import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { asBotId } from "@bebots/domain";
import { createNodeBotWorkspace } from "./workspace";

describe("createNodeBotWorkspace", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bebots-ws-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates home directory structure and writes persona", async () => {
    const ws = createNodeBotWorkspace({ root: dir });
    const id = asBotId("bot-1");
    const home = await Effect.runPromise(ws.ensureHome(id));
    expect(existsSync(home)).toBe(true);
    expect(existsSync(join(home, "notes"))).toBe(true);
    expect(existsSync(join(home, "memory"))).toBe(true);
    expect(existsSync(join(home, "logs"))).toBe(true);
    expect(existsSync(join(home, ".opencode", "skills"))).toBe(true);

    await Effect.runPromise(ws.writePersona(id, "I am a bot"));
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("I am a bot");
  });

  it("rejects unsafe bot ids", async () => {
    const ws = createNodeBotWorkspace({ root: dir });
    const unsafe = asBotId("../escape");
    await expect(Effect.runPromise(ws.ensureHome(unsafe))).rejects.toThrow();
    expect(() => ws.homePath(unsafe)).toThrow();
  });
});
