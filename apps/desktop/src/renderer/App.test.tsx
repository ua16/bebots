import { avatarFromBotId } from "@bebots/domain";
/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BebotsPreloadApi } from "../shared/preload-api";
import { App } from "./App";

const bot = {
  id: "b1",
  homePath: "/tmp/bots/b1",
  name: "Bot One",
  description: "desc",
  persona: "persona",
  status: "active" as const,
  avatar: avatarFromBotId("b1"),
  createdAt: 1,
  updatedAt: 1,
};

function installApi(overrides: Partial<BebotsPreloadApi> = {}): BebotsPreloadApi {
  const api = {
    platform: "darwin",
    versions: { electron: "33", chrome: "130" },
    workspace: { getRoot: vi.fn(async () => "/tmp/bots") },
    apiEndpoint: vi.fn(async () => null),
    bots: {
      list: vi.fn(async () => [bot]),
      get: vi.fn(async () => bot),
      create: vi.fn(async () => bot),
      update: vi.fn(async () => bot),
      archive: vi.fn(async () => bot),
    },
    runs: {
      start: vi.fn(async () => ({
        id: "r1",
        botId: "b1",
        triggerType: "manual",
        prompt: "do it",
        status: "running",
        timeoutMs: 1,
        createdAt: 1,
        updatedAt: 1,
      })),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      cancel: vi.fn(async () => null),
      events: vi.fn(async () => []),
      await: vi.fn(async () => ({
        id: "r1",
        botId: "b1",
        triggerType: "manual",
        prompt: "do it",
        status: "succeeded",
        timeoutMs: 1,
        summary: "all done",
        createdAt: 1,
        updatedAt: 2,
      })),
    },
    ...overrides,
  } as unknown as BebotsPreloadApi;
  (window as unknown as { bebots?: unknown }).bebots = api;
  return api;
}

describe("App", () => {
  beforeEach(() => {
    delete (window as unknown as { bebots?: unknown }).bebots;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the product title and tagline", () => {
    render(<App />);
    expect(screen.getByText("bebots")).toBeTruthy();
    expect(screen.getByText("Local-first multi-bot agent hub")).toBeTruthy();
  });

  it("shows unavailable when the preload bridge is missing", () => {
    render(<App />);
    expect(screen.getByText("Platform: unavailable")).toBeTruthy();
  });

  it("shows the platform from the preload bridge", () => {
    (
      window as unknown as {
        bebots: { platform: string; versions: { electron: string; chrome: string } };
      }
    ).bebots = {
      platform: "darwin",
      versions: { electron: "33", chrome: "130" },
    };
    render(<App />);
    expect(screen.getByText("Platform: darwin")).toBeTruthy();
    delete (window as unknown as { bebots?: unknown }).bebots;
  });

  it("shows the workspace root and runs a bot", async () => {
    const api = installApi();
    render(<App />);

    expect(await screen.findByText("Bots home: /tmp/bots")).toBeTruthy();

    fireEvent.click(await screen.findByText("Bot One"));
    fireEvent.click(await screen.findByRole("button", { name: "Bot settings" }));

    const prompt = await screen.findByLabelText("Prompt");
    fireEvent.change(prompt, { target: { value: "do it" } });
    fireEvent.click(screen.getByText("Run"));

    expect(await screen.findByText("Run: succeeded")).toBeTruthy();
    expect(screen.getByText("all done")).toBeTruthy();
    expect(api.runs.start).toHaveBeenCalledWith({ botId: "b1", prompt: "do it" });
    expect(api.runs.await).toHaveBeenCalledWith("r1", 120000);
  });

  it("surfaces run failures", async () => {
    const api = installApi();
    (api.runs.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    render(<App />);

    fireEvent.click(await screen.findByText("Bot One"));
    fireEvent.click(await screen.findByRole("button", { name: "Bot settings" }));
    fireEvent.click(await screen.findByText("Run"));

    expect(await screen.findByText("Run: failed")).toBeTruthy();
    expect(screen.getByText("Error: boom")).toBeTruthy();
  });

  it("tolerates a workspace root lookup failure", async () => {
    installApi({
      workspace: { getRoot: vi.fn(async () => Promise.reject(new Error("nope"))) },
    });
    render(<App />);
    expect(await screen.findByText("Bot One")).toBeTruthy();
  });

  it("lists conversations and sends a message over the HTTP API", async () => {
    installApi({
      apiEndpoint: vi.fn(async () => ({ url: "http://127.0.0.1:4747", token: "tok" })),
    });
    let thread:
      | {
          id: string;
          conversationId: string;
          senderType: "bot" | "human";
          content: string;
          deliveryState: string;
          createdAt: number;
        }[]
      | undefined = undefined;
    let sent = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace("http://127.0.0.1:4747", "");
      const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === "/api/v1/conversations") {
        if (init?.method === "POST") {
          return ok(
            {
              id: "c1",
              kind: "direct",
              title: "New conversation",
              participants: [],
              createdAt: 1,
              updatedAt: 1,
            },
            201,
          );
        }
        return ok([
          {
            id: "c1",
            kind: "direct",
            title: "Hello chat",
            participants: ["b1"],
            createdAt: 1,
            updatedAt: 1,
          },
        ]);
      }
      if (path === "/api/v1/conversations/c1/messages") {
        const baseThread = [
          {
            id: "m1",
            conversationId: "c1",
            senderType: "bot" as const,
            content: "greetings",
            deliveryState: "delivered" as const,
            createdAt: 1,
          },
        ];
        if (thread === undefined) {
          thread = baseThread;
        }
        if (init?.method === "POST") {
          sent = true;
          thread = [
            ...thread,
            {
              id: "m2",
              conversationId: "c1",
              senderType: "human" as const,
              content: "why hello",
              deliveryState: "delivered" as const,
              createdAt: 2,
            },
          ];
          // New contract (issue #18): the reply run is started server-side and
          // its id comes back with the persisted message.
          return ok({ message: thread[thread.length - 1], runId: "r1" }, 201);
        }
        // After the send, the bot's completed reply run has landed in the
        // thread — the UI's post-send polling picks it up.
        if (sent && !thread.some((m) => m.id === "m3")) {
          thread = [
            ...thread,
            {
              id: "m3",
              conversationId: "c1",
              senderType: "bot" as const,
              content: "here you go",
              deliveryState: "delivered" as const,
              createdAt: 3,
            },
          ];
        }
        return ok(thread);
      }
      return ok([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    // Conversation list arrives over HTTP; opening it loads the thread.
    fireEvent.click(await screen.findByText("Hello chat"));
    expect(await screen.findByText("greetings")).toBeTruthy();

    // Send appends over HTTP, refreshes the thread, and the bot's reply run
    // result arrives via post-send polling (full reply loop, issue #18).
    const input = screen.getByPlaceholderText("Message Bot One");
    fireEvent.change(input, { target: { value: "why hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("why hello")).toBeTruthy();
    await screen.findByText("here you go", {}, { timeout: 5_000 });

    // The typed client rides FetchHttpClient: find the actual send and assert
    // the wire shape (auth header + JSON body) at that call.
    const sendCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "http://127.0.0.1:4747/api/v1/conversations/c1/messages" &&
        init?.method === "POST",
    );
    expect(sendCall).toBeDefined();
    const headers = sendCall?.[1]?.headers;
    const auth =
      typeof headers === "object" && headers !== null
        ? (Reflect.get(headers, "authorization") ?? Reflect.get(headers, "Authorization"))
        : undefined;
    expect(auth).toBe("Bearer tok");
    // FetchHttpClient sends the encoded payload as raw bytes; decode for the
    // shape assertion.
    const rawBody = sendCall?.[1]?.body;
    let bodyText: string;
    if (typeof rawBody === "string") {
      bodyText = rawBody;
    } else if (rawBody instanceof Uint8Array) {
      bodyText = new TextDecoder().decode(rawBody);
    } else if (rawBody instanceof ArrayBuffer) {
      bodyText = new TextDecoder().decode(rawBody);
    } else {
      bodyText = String(rawBody);
    }
    expect(JSON.parse(bodyText)).toEqual({ content: "why hello" });
  });

  it("deletes a session from the sidebar right-click menu", async () => {
    installApi({
      apiEndpoint: vi.fn(async () => ({ url: "http://127.0.0.1:4747", token: "tok" })),
    });
    let deleted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace("http://127.0.0.1:4747", "");
      const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === "/api/v1/conversations") {
        return ok(
          deleted
            ? []
            : [
                {
                  id: "c1",
                  kind: "direct",
                  title: "Hello chat",
                  participants: ["b1"],
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
        );
      }
      if (path === "/api/v1/conversations/c1" && init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return ok([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.contextMenu(await screen.findByText("Hello chat"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete session" }));

    expect(await screen.findByText("No sessions yet")).toBeTruthy();
    expect(screen.queryByText("Hello chat")).toBeNull();
    expect(deleted).toBe(true);
  });

  it("autosaves name changes after a short debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let stored: typeof bot & { model?: { providerID: string; id: string } | null } = { ...bot };
    const api = installApi({
      bots: {
        list: vi.fn(async () => [{ ...stored }]),
        get: vi.fn(async () => ({ ...stored })),
        create: vi.fn(async () => ({ ...stored })),
        update: vi.fn(async (_id, input) => {
          stored = {
            ...stored,
            ...input,
            avatar: input.avatar ?? stored.avatar,
            model: input.model !== undefined ? input.model : stored.model,
            updatedAt: stored.updatedAt + 1,
          };
          return { ...stored };
        }),
        archive: vi.fn(async () => ({ ...stored })),
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByText("Bot One"));
    fireEvent.click(await screen.findByRole("button", { name: "Bot settings" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Autosaved" } });

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => {
      expect(api.bots.update).toHaveBeenCalledWith(
        "b1",
        expect.objectContaining({ name: "Autosaved" }),
      );
    });
    vi.useRealTimers();

    cleanup();
    (window as unknown as { bebots?: unknown }).bebots = api;
    render(<App />);
    fireEvent.click(await screen.findByText("Autosaved"));
    fireEvent.click(await screen.findByRole("button", { name: "Bot settings" }));
    expect((await screen.findByLabelText("Name") as HTMLInputElement).value).toBe("Autosaved");
  });

  it("persists avatar when the edit dialog closes", async () => {
    const nextAvatar = { face: "face-0", color: 0, shape: "squircle" as const };
    let stored: typeof bot & { model?: { providerID: string; id: string } | null } = { ...bot };
    const api = installApi({
      bots: {
        list: vi.fn(async () => [{ ...stored }]),
        get: vi.fn(async () => ({ ...stored })),
        create: vi.fn(async () => ({ ...stored })),
        update: vi.fn(async (_id, input) => {
          stored = {
            ...stored,
            ...input,
            avatar: input.avatar ?? stored.avatar,
            model: input.model !== undefined ? input.model : stored.model,
            updatedAt: stored.updatedAt + 1,
          };
          return { ...stored };
        }),
        archive: vi.fn(async () => ({ ...stored })),
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByText("Bot One"));
    fireEvent.click(await screen.findByRole("button", { name: "Bot settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit avatar" }));
    fireEvent.click(screen.getByRole("button", { name: "face-0" }));
    fireEvent.click(screen.getByRole("button", { name: "Color 0" }));
    fireEvent.click(screen.getByRole("button", { name: "Squircle" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await vi.waitFor(() => {
      expect(api.bots.update).toHaveBeenCalledWith(
        "b1",
        expect.objectContaining({ avatar: nextAvatar }),
      );
    });

    cleanup();
    (window as unknown as { bebots?: unknown }).bebots = api;
    render(<App />);
    fireEvent.click(await screen.findByText("Bot One"));
    fireEvent.click(await screen.findByRole("button", { name: "Bot settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit avatar" }));
    expect(screen.getByRole("button", { name: "face-0" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Color 0" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Squircle" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("asks for confirmation before deleting a bot from the sidebar menu", async () => {
    const botList = [bot];
    installApi({
      apiEndpoint: vi.fn(async () => ({ url: "http://127.0.0.1:4747", token: "tok" })),
      bots: {
        list: vi.fn(async () => [...botList]),
        get: vi.fn(async () => bot),
        create: vi.fn(async () => bot),
        update: vi.fn(async () => bot),
        archive: vi.fn(async () => bot),
      },
    });
    let deleted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace("http://127.0.0.1:4747", "");
      const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === "/api/v1/conversations") return ok([]);
      if (path === "/api/v1/bots/b1" && init?.method === "DELETE") {
        deleted = true;
        botList.length = 0;
        return new Response(null, { status: 204 });
      }
      return ok([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.contextMenu(await screen.findByText("Bot One"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete bot" }));

    expect(screen.getByRole("dialog", { name: "Delete bot?" })).toBeTruthy();
    expect(deleted).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Delete bot?" })).toBeNull();
    expect(deleted).toBe(false);
    expect(screen.getByText("Bot One")).toBeTruthy();

    fireEvent.contextMenu(await screen.findByText("Bot One"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete bot" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No conversations yet")).toBeTruthy();
    expect(screen.queryByText("Bot One")).toBeNull();
    expect(deleted).toBe(true);
  });
});
