# ADR 0001: HTTP API architecture — Effect `HttpApi` with Effect Schema

Date: 2026-10-30
Status: Accepted
Related: [REFACTOR-PLAN.md](../../REFACTOR-PLAN.md), GitHub issues #12, #31

## Context

Milestones 0–5 shipped the local HTTP API inline in the Electron main process
(`apps/desktop/src/main/index.ts`): `node:http`, if/else regex routing (~36 dispatch
points), untyped `as` casts at every body/param boundary, no error mapping (one outer
catch-all → `500`), `zod` unused in the layer. Milestone 6 of PLAN.md requires auth
middleware, SSE, OpenAPI, error envelopes, and pagination uniformly across ~35 routes;
the current layer cannot host them. PLAN.md's stack table already points at
`@effect/platform` for the HTTP layer and Effect Schema for validation, and
`effect@4.0.5` is already a runtime dependency of four packages.

## Decision

Migrate the API to Effect v4's first-party `HttpApi` stack (`effect/http-api` +
`effect/http` + `@effect/platform-node@4`) with Effect `Schema`, in a single big-bang
milestone ("API layer foundation") that ships **wire-behavior parity only**; the five
capabilities land as Milestone 6 on top of the new structure.

Specifics:

1. **`packages/api` owns the whole API** — endpoint definitions, schemas, handlers, and
   the `HttpApiBuilder` server assembly, consuming `@bebots/application` services as
   layers. The desktop app is only the composition root (service wiring, ephemeral port,
   `api-port.txt`, IPC endpoint bridge). This makes a future headless daemon a
   composition-root swap.
2. **Effect-first contract**: the renderer imports `HttpApiClient` from `@bebots/api`.
   No codegen; one source of truth. Effect in the renderer bundle is accepted.
3. **Contract-preserving migration**: the main-process HTTP suites are the acceptance
   gate and pass unchanged, except a short named-exception list (first entry: malformed
   JSON body 500 → 400).
4. **Domain validators move to Effect Schema end-to-end** (bounded: ~3 validators, ~6
   call sites). Branded IDs migrate gradually to `Schema.brand`; hand-rolled `as*` casts
   keep working during the transition but no new ones may be added.
5. **`/mcp` is out of scope** — it stays a sibling handler (MCP SDK owns that protocol);
   the boundary is documented rather than unified.
6. **Security behavior is frozen**: missing-token-allowed, plaintext `/token`, wildcard
   CORS are preserved for parity and tracked for Milestone 6 in GitHub issue #31.

## Consequences

- The renderer's `apiFetch<T>` + triple-duplicated `Api*` interfaces are replaced by a
  typed, schema-derived client; renames propagate at compile time end-to-end.
- Error envelopes, auth middleware, OpenAPI (in-core `OpenApi`/`HttpApiScalar`), SSE, and
  pagination become incremental Milestone 6 work on uniform structure instead of 35
  bespoke edits.
- The big-bang moment is large (all routes + renderer client + test cutover in one
  milestone). Mitigated by increment PRs against a single stack, the contract gate, and
  per-PR manual UI checklists.
- `@effect/platform` per se is _not_ installed: Effect v4 ships the HTTP stack in core
  and `@effect/platform-node` provides the Node server adapter (verified against
  `effect@4.0.5` / `@effect/platform-node@4.x`).
- Effect idioms (`Effect.gen`, `Effect.fn`, `Context.Service`, `Schema`, layers) become
  the required pattern vocabulary for API code; the library's in-package `ai-docs` and
  `AGENTS.md` are the canonical references.
