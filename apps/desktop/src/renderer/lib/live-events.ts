import type { ApiEndpoint } from "../apiClient";

export type LiveEvent =
  | {
      readonly v: 1;
      readonly id: string;
      readonly at: number;
      readonly kind: "activity";
      readonly activity: {
        readonly id: string;
        readonly type: string;
        readonly entityType: string;
        readonly entityId: string;
        readonly actorId: string | null;
        readonly payload?: unknown;
        readonly createdAt: number;
      };
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly at: number;
      readonly kind: "run.event";
      readonly runId: string;
      readonly event: unknown;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly at: number;
      readonly kind: "run.updated";
      readonly run: {
        readonly id: string;
        readonly status: string;
        readonly conversationId?: string;
        readonly summary?: string;
        readonly [key: string]: unknown;
      };
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly at: number;
      readonly kind: "conversation.updated";
      readonly conversationId: string;
      readonly reason: "created" | "updated" | "deleted" | "message";
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly at: number;
      readonly kind: "schedule.updated";
      readonly scheduleId: string;
      readonly botId: string;
      readonly reason: "created" | "updated" | "deleted" | "occurrence";
    };

function parseSseBlocks(buffer: string): { readonly events: LiveEvent[]; readonly rest: string } {
  const events: LiveEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    try {
      events.push(JSON.parse(dataLines.join("\n")) as LiveEvent);
    } catch {
      /* ignore malformed frames */
    }
  }
  return { events, rest };
}

/**
 * Subscribe to `GET /api/v1/events` and invoke `onEvent` for each frame.
 * Reconnects with a short backoff until `signal` aborts.
 */
export async function subscribeLiveEvents(
  endpoint: ApiEndpoint,
  onEvent: (event: LiveEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let backoffMs = 500;
  while (!signal.aborted) {
    try {
      const res = await fetch(`${endpoint.url}/api/v1/events`, {
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          Accept: "text/event-stream",
        },
        signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE ${res.status}`);
      }
      backoffMs = 500;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) onEvent(event);
      }
    } catch {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoffMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      backoffMs = Math.min(backoffMs * 2, 8_000);
    }
  }
}
