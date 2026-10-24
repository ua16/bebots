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
