# Architecture and dependency direction

## Package dependency direction

> Note: `persistence`, `agent-runtime`, `runtime-*`, and `api` are planned
> packages and are not yet scaffolded in this repository. The direction
> rules below describe the intended end state.

Dependencies flow inward. Outer layers may depend on inner layers; inner
layers must never depend on outer layers.

```
shared  <-  domain  <-  application  <-  persistence
                                   <-  agent-runtime  <-  runtime-*
                                   <-  api
apps/desktop (composition root) depends on everything above
```

Rules:

- `packages/domain` depends on nothing internal.
- `packages/application` depends on `domain` and `shared` only.
- `packages/persistence` depends on `domain` and `application` interfaces only.
- `packages/agent-runtime` defines the shared run lifecycle and depends on
  `domain`/`application`.
- `packages/runtime-*` implement `AgentRuntime` and depend on
  `agent-runtime`, never the reverse.
- `packages/api` depends on `application` and `domain`; it validates input
  and maps errors but contains no business rules.
- `apps/desktop` is the composition root and wires concrete implementations.

## Runtime adapter contract

See `packages/application/src/runtime.ts`. Every adapter implements
`AgentRuntime`:

- `id`: stable adapter identifier.
- `capabilities`: explicit capability flags (`streaming`,
  `resumableSessions`, `cancellation`).
- `startRun(request)`: launch a run in the bot's home directory.
- `cancelRun(handle)`: request cancellation.
- `streamEvents(handle)`: stream normalized runtime events.
- `getResult(handle)`: fetch the final result.

Adapters must normalize runtime-specific events into `RuntimeEvent`.
Capability differences must be represented explicitly.
