# REFACTOR-PLAN.md — API layer foundation

This is the working plan for the **API layer foundation** refactor: migrating the inline
HTTP API out of `apps/desktop/src/main/index.ts` onto Effect `HttpApi` with Effect Schema.
It is the prerequisite for PLAN.md's Milestone 6 ("External API and hardening"); PLAN.md
itself is left untouched on purpose.

Status: **planning done, execution in progress** (2026-10-30).
Decisions were grilled and confirmed by the repo owner; they are recorded in
[`docs/adr/0001-http-api-architecture.md`](docs/adr/0001-http-api-architecture.md).

## Why

Milestones 0–5 shipped with the HTTP layer written inline in the Electron main process
(`apps/desktop/src/main/index.ts`, ~1,276 lines): `node:http` + if/else regex routing,
~36 dispatch points, ~50 `as` casts, hand-rolled `readBody`/`sendJson`, and a single outer
`try/catch` that maps everything to `500 { error }`. Every capability Milestone 6 needs
(auth middleware, SSE, OpenAPI, error envelopes, pagination) requires uniform structure
that this layer cannot provide.

Ground facts (as of milestone start):

- The server is created **inside** `setupBotService()`, closing over ~10 services. The
  service wiring must be lifted before the router can move.
- `effect@4.0.5` is already a runtime dependency of `apps/desktop`, `packages/application`,
  `packages/persistence`, `packages/runtime-opencode`, but no `@effect/*` packages were
  installed and the HTTP layer used none of it.
- The renderer is a real HTTP client: ~18 `apiFetch` call sites in `App.tsx` hitting
  `/api/v1/*`, with hand-duplicated `Api*` interfaces (domain ↔ preload ↔ renderer
  triplication). Only `workspace` rides IPC.
- Integration suites (`apps/desktop/src/main/*.test.ts`) recreate the same ~50-line boot
  fixture each; there is no shared HTTP test helper.
- `zod` is only used by `apps/desktop/src/main/mcp.ts`; the domain "validators"
  (`validateModelRef`, `validateScheduleTrigger`) are hand-written result objects, not zod.
- Auth today: token from `api-token.txt`, missing `Authorization` = allowed, plaintext
  `GET /api/v1/token`, wildcard CORS. These are **frozen for parity** and tracked in
  [#31](https://github.com/ua16/bebots/issues/31).
- PLAN.md reserved a `packages/api` package ("HTTP routes, schemas, OpenAPI, auth") that
  was never scaffolded; related pre-existing issue: #12.

## Decisions (confirmed)

| #   | Decision                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Effect `HttpApi` is the strategic goal; the five capabilities ship **after** this refactor, as Milestone 6. Parity only here.                                                                                                                                                                                    |
| D2  | Big-bang, single milestone (no users; fat branch survivable).                                                                                                                                                                                                                                                    |
| D3  | Code is largely agent-written: canonical exemplars, uniform patterns, reviewable increment PRs.                                                                                                                                                                                                                  |
| D4  | Main-process HTTP suites are the **contract**: they must pass unchanged except named, documented exceptions (see gate rules).                                                                                                                                                                                    |
| D5  | **Q9/Q11(b)**: decouple frontend from backend as much as is sensible now — renderer imports only `@bebots/api`; server structured so a future headless daemon is a composition-root swap. Same Electron process today.                                                                                           |
| D6  | **Effect-first contract**: renderer depends on `@bebots/api` `HttpApiClient`; Effect in the renderer bundle is accepted. No codegen, single source of truth.                                                                                                                                                     |
| D7  | `/mcp` (MCP SDK passthrough) is **out of scope**; stays a sibling handler on the same port.                                                                                                                                                                                                                      |
| D8  | Auth quirks (missing-token allowed, plaintext `/token`, wildcard CORS) **frozen**; tracked in #31, not touched here.                                                                                                                                                                                             |
| D9  | Domain validators → Effect `Schema` end-to-end (bounded: ~3 validators, ~6 call sites). Brands migrate gradually to `Schema.brand`; hand-rolled `as*` casts keep working but **no new ones are allowed**.                                                                                                        |
| D10 | Handlers + server assembly live in `packages/api` (D5/D21 arrangement): endpoints, schemas, `HttpApiBuilder` layer consuming `@bebots/application` services. Desktop main only wires repositories → services → api layer, listens on the ephemeral port, writes `api-port.txt`, exposes the IPC endpoint bridge. |
| D11 | Milestone branch + increment PRs; a PR to `main` exists but **agents never merge — the owner merges on request**.                                                                                                                                                                                                |
| D12 | Docs live in this file + `docs/adr/0001-*.md` + an AGENTS.md pointer. PLAN.md untouched; no `CONTEXT.md`.                                                                                                                                                                                                        |

## Effect v4 machinery (verified against `effect@4.0.5`)

Effect v4 core ships the HTTP stack as first-party exports — **no `@effect/platform`**
package exists for v4 (registry maxes at `0.97.x`, which targets effect 3.x):

- `effect/http-api` — `HttpApi`, `HttpApiEndpoint`, `HttpApiGroup`, `HttpApiBuilder`,
  `HttpApiClient`, `HttpApiMiddleware`, `HttpApiScalar`, `HttpApiSwagger`, `OpenApi`.
- `effect/http` — `HttpRouter` (`HttpRouter.serve(routes)`), `FetchHttpClient`,
  `HttpClient`, `HttpClientRequest`, `HttpServer`.
- Node server adapter: `@effect/platform-node@4` (`NodeHttpServer.layer(createServer,
{ port })`, `NodeRuntime.runMain`). Peer-dep matches `effect@^4.0.x`, compatible with
  `4.0.5`.
- First-party docs ship **inside the installed package** at
  `node_modules/effect/ai-docs/src/` — `51_http-server/10_basics.ts` is the canonical
  exemplar for serve + client wiring; `51_http-server/20_testing.ts` covers in-memory
  handler testing via `HttpApiTest`; and the package carries `AGENTS.md` guidance for
  Effect style (`Effect.gen`, `Effect.fn`, `Context.Service`, `Schema.TaggedError`,
  `Predicate` instead of hand-rolled type guards). **Read these before writing route code.**
- The renderer client path is browser-safe: `FetchHttpClient.layer` + `HttpApiClient.make(Api,
{ transformClient })` to prepend the base URL and attach the bearer token.
- Schema v4 codecs are **total**: `Schema.decodeUnknownSync` ignores excess properties, and
  `Schema.encodeSync` **drops** them (plus omitting declared optionals whose value is
  `undefined`) — so a narrowed response schema is wire-identical to the old
  `JSON.stringify(domainObject)` only if it declares **every** serialized field.
- Under `exactOptionalPropertyTypes`, `Schema.optional` output types flow as `T | undefined`
  (plus `| null` where `NullOr` is declared) — narrow local views must widen their optional
  slots with `| undefined` to accept contract-typed values without casts.
- Renderer transport facts (verified in `App.test.tsx`): the client's `fetch` receives a
  `URL` object (not a string), lowercased header keys (`authorization`), tracer headers, an
  `AbortSignal`, and a `Buffer`/bytes body; raw `fetch` mocks must return real `Response`s.

## Target architecture

```
shared ← domain ← application ← +--------------+
                                | packages/api |   ← NEW: endpoints, schemas, handlers,
                                +--------------+       HttpApiBuilder assembly, error types,
shared ← domain ← +-----------------------------+      client factory
                  | packages/persistence        |
                  `-----------------------------`
                          ↑
apps/desktop = composition root only: wire repos → services → @bebots/api server,
               ephemeral port + api-port.txt, IPC endpoint bridge, /mcp sibling mount
apps/desktop/src/renderer = HTTP client of @bebots/api via HttpApiClient (no domain knowledge)
```

Delete list (gone by PR 3): regex dispatch chain, `readBody`, hand-placed `sendJson` calls,
outer catch-all 500, `validateModelRef`/`validateScheduleTrigger` hand-written forms,
12× `body as {...}` casts.

Not touched: `/mcp` routing, `api-token.txt`/auth semantics (see #31), CORS/OPTIONS
behavior (see #31), PLAN.md, `CONTEXT.md`.

## PR stack (linear, each merges into the previous — agents never merge)

Branches: `milestone/api-layer` → `api/foundation-1` → `api/foundation-2` …; the bottom
PR targets `main`. When the owner approves a merge, the stack retargets bottom-up.
After each PR the app must **build, typecheck, lint, and pass tests, and be in a working
state when run by hand** (`bun run dev`; owner manual-tests from the PR checklist).

| PR  | Branch                | Contents                                                                                                                                                                                                                                                 | Gate                                                                                                                                |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `milestone/api-layer` | This plan, ADR 0001, AGENTS.md pointer, `packages/api` scaffold (deps: `@bebots/domain`, `@bebots/shared`, `@bebots/application`, `effect@^4`, `@effect/platform-node@^4`)                                                                               | Docs complete; scaffold typechecks; app unaffected                                                                                  |
| 2   | `api/foundation-1`    | Domain validators → Effect `Schema`; `Schema.brand` IDs introduced alongside hand-rolled ones; ~6 call sites in `application`/`persistence` updated; `packages/api` exports endpoint definitions + schemas (contract compiler-checked, handlers stubbed) | Domain/application/persistence tests green unchanged; `tsc -b` clean                                                                |
| 3   | `api/foundation-2`    | **Server cutover**: `HttpApiBuilder` handlers wired to real services in `packages/api`; desktop main slimmed to wiring; regex router deleted                                                                                                             | **Contract gate**: all main-process HTTP suites green (exceptions below); boot route (`api-port.txt`) unchanged; `/mcp` still works |
| 4   | `api/foundation-3`    | Renderer swaps `apiFetch<T>` + duplicated `Api*` types for `@bebots/api` `HttpApiClient`                                                                                                                                                                 | Renderer tests adapted where they mock raw fetch; app works end-to-end                                                              |
| 5   | `api/foundation-4`    | Shared test boot fixture replaces ~50-line per-suite duplication; drop stray `as unknown as` casts in HTTP tests; remove `bun-test.log`/`full-test.log`                                                                                                  | All suites green; no behavior change                                                                                                |
| —   | —                     | Owner merges stack into `main` (bottom-up)                                                                                                                                                                                                               | On explicit owner request only                                                                                                      |

### Contract gate rules

1. Main-process HTTP suites (`apps/desktop/src/main/*.test.ts`) pass **unchanged**, except
   entries on the named-exception list below.
2. Each exception: one-line rationale in the PR description + updated assertion.
3. Renderer tests that mock raw `fetch` URLs are _not_ contract tests; they may be
   adapted in PR 4.
4. Named exceptions so far: malformed JSON body ⇒ **400** instead of 500 (current 500 is
   an accidental behavior of the bare `JSON.parse` catch; the Effect validation layer
   maps undecodable bodies to 4xx; part of #31's error-envelope endgame).

### Manual UI test checklist (include verbatim in every PR description)

Launch with `bun run dev`, then:

- [ ] App boots; bot list renders; create a bot; edit a bot name
- [ ] Open a conversation; send a message; bot reply streams in; switch conversations
- [ ] Create a schedule (interval); see occurrences; update it; delete it
- [ ] Settings: change default model; persisted after app restart
- [ ] Restart app: data intact (persistence round-trip)

**Do not manual-test features that have no renderer affordance yet.** As of
2026-10-30 these HTTP routes exist with passing suites but no UI surface in
`App.tsx`: run cancel / run events, task delegate + pause/resume/stop control,
notes search, activity feed, token endpoint. Add them to this checklist only once
their UI lands (owner-verified working list above, 2026-10-30).

PRs 2–5 add per-scope items to this list in their descriptions.

## Conventions for agents working on this refactor

- Package management is `bun` only. Runs typecheck via `bun run typecheck` (tsc -b), lint
  via `bun run lint`, tests via `bun run test`.
- Before writing `HttpApi`/`Schema`/service code, read the in-package docs:
  `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/src/51_http-server/`.
  Style rules from there are binding (`Effect.gen` over `Effect.runPromise`-from-callbacks,
  `Effect.fn`, `Context.Service`, `Schema` over manual parsing, `Predicate` over
  hand-rolled guards).
- Patterns are copied forward: PR 3's first migrated route is the exemplar; subsequent
  routes must follow it mechanically. If a route needs something the exemplar lacks,
  extend the exemplar pattern first, then apply it everywhere it applies.
- **No new hand-rolled casts** (`as SomeType`) anywhere in `packages/api` or touched
  renderer code. Pre-existing casts are only removed opportunistically.
- Wire behavior parity is the law. When in doubt, check what the regex router did and
  what the suite asserts: `_ = contract_`.
- Agents **never merge** any PR (this file's PR stack, the bottom PR, anything). The
  owner merges.
- If a fact from this file proves wrong, fix this file in the same PR and note it in the
  PR description.

## Related

- `docs/adr/0001-http-api-architecture.md` — decision record
- GitHub issue #31 — M6 hardening item for the frozen auth/CORS quirks
- GitHub issue #12 — original observation about the ad-hoc `node:http` API
- `PLAN.md` Milestone 6 — the capabilities that follow on top of this structure
