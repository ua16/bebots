import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { asBotId } from "@bebots/domain";
import { BotService } from "./bot-service.js";
import type { BotRepository, BotWorkspace, Clock, IdGenerator } from "./repositories.js";

describe("BotService", () => {
  it("creates a bot and writes persona", async () => {
    const store = new Map();
    const repo: BotRepository = {
      create: (bot) => {
        store.set(bot.id, bot);
        return Effect.succeed(bot);
      },
      findById: (id) => Effect.succeed(store.get(id) ?? null),
      findAll: () => Effect.succeed([...store.values()]),
      update: (bot) => {
        store.set(bot.id, bot);
        return Effect.succeed(bot);
      },
      delete: (id) => {
        store.delete(id);
        return Effect.void;
      },
    };
    const ensured: string[] = [];
    const personas: { id: string; persona: string }[] = [];
    const workspace: BotWorkspace = {
      root: "/tmp/bots",
      ensureHome: (id) => {
        ensured.push(id);
        return Effect.succeed(`/tmp/bots/${id}`);
      },
      writePersona: (id, persona) => {
        personas.push({ id, persona });
        return Effect.void;
      },
      homePath: (id) => `/tmp/bots/${id}`,
    };
    const clock: Clock = { now: () => 42 };
    const ids: IdGenerator = { generate: () => "bot-1" };
    const service = new BotService(repo, workspace, clock, ids);

    const bot = await Effect.runPromise(
      service.createBot({ name: "Alice", description: "d", persona: "hi" }),
    );
    expect(bot.id).toBe("bot-1");
    expect(bot.createdAt).toBe(42);
    expect(ensured).toEqual(["bot-1"]);
    expect(personas).toEqual([{ id: "bot-1", persona: "hi" }]);

    const updated = await Effect.runPromise(
      service.updateBot(asBotId("bot-1"), { name: "Alice2", persona: "hello" }),
    );
    expect(updated.name).toBe("Alice2");
    expect(updated.persona).toBe("hello");
  });

  it("rejects empty names", async () => {
    const store = new Map();
    const repo: BotRepository = {
      create: (bot) => {
        store.set(bot.id, bot);
        return Effect.succeed(bot);
      },
      findById: (id) => Effect.succeed(store.get(id) ?? null),
      findAll: () => Effect.succeed([...store.values()]),
      update: (bot) => Effect.succeed(bot),
      delete: () => Effect.void,
    };
    const workspace: BotWorkspace = {
      root: "/tmp/bots",
      ensureHome: () => Effect.succeed("/tmp"),
      writePersona: () => Effect.void,
      homePath: (id) => `/tmp/${id}`,
    };
    const service = new BotService(repo, workspace, { now: () => 1 }, { generate: () => "x" });
    await expect(Effect.runPromise(service.createBot({ name: "   " }))).rejects.toThrow();
  });
});
