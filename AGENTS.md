# AGENTS.md

## Packages

Use `bun` instead of `npm` and `pnpm` for all package management and script running (`bun install`, `bun run <script>`, `bunx`). Never use `npm` or `pnpm`.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`ua16/bebots`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### In progress: API layer foundation refactor

The HTTP API is being migrated to Effect `HttpApi` (milestone branch stack; see
`REFACTOR-PLAN.md` and `docs/adr/0001-http-api-architecture.md`). While this is in
flight: agents never merge PRs, no new hand-rolled `as` casts, wire-behavior parity is
the contract, and `PLAN.md` is untouched. Read `REFACTOR-PLAN.md` before touching
`packages/api`, the HTTP routes, or the renderer client.
