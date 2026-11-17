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

### Headless server (for testing)

Start the bot server without the Electron window: `bun run dev -- --headless` (or `BEBOTS_HEADLESS=1`). Port is written to `api-port.txt` in user data; token in `api-token.txt`.

## Coding Guidance

In this repo code exists to explain how something happens, do not use comments in code files unless absolutely necessary (i.e. when the code you wrote does not make sense in the context of the rest of the file).

Always make the smallest and simplest changes to achieve a deeloper's request. Before attempting a change that alters the archictecture of a project go over your decisions with the developer.

Never create solutions that are temporary or workarounds. If a problem exists attack it at its source. If it requires a major confirm with the developer if that is indeed the direction they intend to go in.
