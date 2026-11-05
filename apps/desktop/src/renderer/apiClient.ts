import { Effect, Predicate } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Api } from "@bebots/api";

export interface ApiEndpoint {
  readonly url: string;
  readonly token: string;
}

/**
 * Typed HTTP client over the @bebots/api contract, scoped to the desktop
 * endpoint handed over IPC (base URL + bearer token). Replaces the old
 * hand-rolled `apiFetch` plumbing with compiler-checked endpoint calls.
 */
type Client = HttpApiClient.ForApi<typeof Api>;

const STATUS_BY_TAG: Readonly<Record<string, number>> = {
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  RequestTimeout: 408,
  Conflict: 409,
  NotImplemented: 501,
  ServiceUnavailable: 503,
  InternalServerError: 500,
};

/** Map typed client errors to the HTTP status the old `apiFetch` threw with. */
function statusOf(error: unknown): number {
  if (Predicate.hasProperty(error, "_tag")) {
    const tag = error._tag;
    if (typeof tag === "string" && STATUS_BY_TAG[tag] !== undefined) {
      return STATUS_BY_TAG[tag]!;
    }
  }
  return 500;
}

function makeClient(endpoint: ApiEndpoint): Effect.Effect<Client> {
  return HttpApiClient.make(Api, {
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(endpoint.url)),
        HttpClient.mapRequest(HttpClientRequest.bearerToken(endpoint.token)),
      ),
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

/**
 * Run a typed client call and surface the same Error shape the old `apiFetch`
 * produced ("API <path> failed: <status>"), so user-visible messages are
 * unchanged (plumbing-only parity).
 */
export function apiRequest<T>(
  endpoint: ApiEndpoint,
  path: string,
  call: (client: Client) => Effect.Effect<T, unknown>,
): Promise<T> {
  return Effect.runPromise(
    Effect.flatMap(makeClient(endpoint), call).pipe(
      Effect.mapError((error) => new Error(`API ${path} failed: ${statusOf(error)}`)),
    ),
  );
}
