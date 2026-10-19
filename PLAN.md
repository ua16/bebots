# PLAN.md --- Local-First Multi-Bot Agent Hub

## 1. Product summary

Build a local-first desktop application for creating and managing
persistent AI bots. Each bot has a profile/persona, private workspace,
notes and memory, conversations, tools, and schedules. Bots can
communicate with the user and with one another through the application.

The product is a **persistent AI workforce**, not a conventional
chatbot: bots have durable identities, can delegate and collaborate,
run on schedules, and operate under human oversight.

The app runs on the user's machine and exposes a local HTTP API for
external integrations. It is **not primarily a coding-agent manager**:
coding CLIs and Git access are optional capabilities, not the product's
core abstraction. It is also **not a cloud computer or browser-automation
product**: execution is local, and computer-use/browser automation is not
a goal.

A bot is not a separate process or agent implementation. Each bot is
the **context** (persona in `AGENTS.md`, skills under `.opencode/skills/`,
notes, memory, and logs) materialized as files in its home directory, plus
a resumable OpenCode session. The app owns identity and file materialization;
the runtime (OpenCode) runs with that home directory as its working
directory and discovers the context itself.

### Product principles

- **Local-first:** bot state and workspaces live on the user's
  machine.
- **API-first:** the desktop UI and external clients use the same
  application API.
- **Persistent identity:** a bot's persona and knowledge survive
  individual agent runs and runtime changes.
- **Replaceable runtimes:** bots are domain entities; an execution
  adapter runs them using a supported agent/runtime.
- **Explicit coordination:** the application owns messages, tasks,
  schedules, permissions, and run state.
- **Safe by default:** local API binding, explicit tool permissions,
  auditable runs, bounded execution, and approval gates for
  consequential actions.
- **Small, composable MVP:** begin with one runtime and one local
  database; avoid premature distributed infrastructure.

## 2. Goals and non-goals

### Goals

- Create, edit, archive, and inspect bots.
- Configure each bot's name, avatar, persona, model/runtime,
  instructions, tools, and permissions.
- Give each bot a persistent home directory for notes, memory, and
  files.
- Give each bot one or more conversations and a history of executions.
- Let bots message one another and participate in shared team
  conversations.
- Assign tasks and allow bots to delegate bounded work, including
  parallel runs across multiple bots. Any bot can communicate with any
  other bot.
- Run scheduled tasks while the app is running.
- Provide a human approval queue and policies for sensitive actions.
- Expose an authenticated API and live event stream for external
  clients.
- Recover persistent state and scheduled work after application
  restarts.
- Manage reusable skills as Markdown prompt templates that bots can
  load into context (post-MVP).
- Connect bots to external services via MCP servers (post-MVP).

### Non-goals

- Building a foundation model or a new coding agent.
- Running every bot in a dedicated VM/container.
- Cloud hosting, multi-user collaboration, or remote account
  management.
- Kubernetes, microservices, Redis, or a separate database server.
- Autonomous, unbounded bot-to-bot conversations.
- Unrestricted shell access or automatic execution of high-impact
  actions.
- A complex RAG/vector database system before basic notes and search
  prove insufficient.
- Persistent cloud/remote execution environments; all execution is
  local to the user's machine.
- Browser and computer automation ("computer use"); bots are not
  expected to navigate or control a GUI browser.
- Shared memory or shared workspaces across bots. Bots coordinate
  through messages and tasks; each bot's memory and files stay
  private.
- First-class workspace/Git repository integration. Bots are confined
  to their home directory; if they need a repo they clone it there
  using available tools.

## 3. Recommended technology stack

Use TypeScript end-to-end, with Effect for application logic and
resource management.

---

Area Choice

---

Language TypeScript with strict compiler
settings

Package manager bun workspaces

Desktop shell Electron

UI React + Vite

UI components A small, accessible component
system; select one during
scaffolding

Application/runtime logic Effect (`effect`)

Local HTTP API `@effect/platform` HTTP server
where suitable

Validation and schemas Effect Schema

Persistence SQLite, accessed through a small
repository boundary

Database migrations Versioned SQL migrations

API contract OpenAPI generated or maintained
from route schemas

Live events Server-Sent Events (SSE) initially

Scheduling Persistent schedule records plus a
scheduler service

Tests Vitest; Electron integration tests
after core services stabilize

Formatting/linting Prettier and ESLint or a unified
tool selected during setup

Packaging Electron Forge or electron-builder;
choose one and standardize early
-----------------------------------------------------------------------

### Important implementation constraints

- Keep Electron's renderer isolated: `contextIsolation: true`,
  `nodeIntegration: false`, a narrow preload bridge, and a restrictive
  Content Security Policy.
- Do not expose arbitrary Node APIs to the renderer.
- Keep the domain and application services independent of Electron,
  HTTP, and SQLite.
- Use Effect consistently at service boundaries for typed failures,
  dependency injection, concurrency, cancellation, and resource
  scopes. Avoid wrapping every trivial pure function in an Effect.
- Store application data under Electron's user data directory, not
  inside the installation directory or source tree.
- Pin and test supported Node/Electron versions and each external
  agent CLI's supported invocation protocol.

## 4. Architecture

Start as a **modular monolith**. Run the UI, local API, scheduler, and
agent-run workers under one desktop application lifecycle, with clear
module boundaries. Individual agent processes may run separately when
the chosen runtime requires it.

```text
Electron application
├── Main process
│   ├── Application lifecycle / single-instance handling
│   ├── Local API server
│   ├── Domain + application services (Effect)
│   ├── SQLite repositories + migrations
│   ├── Scheduler and durable task queue
│   ├── Bot messaging and event delivery
│   ├── Runtime adapters and run supervisor
│   └── Workspace / filesystem services
├── Preload
│   └── Narrow, typed IPC bridge
└── Renderer (React)
    ├── Bot directory and profiles
    ├── Chat and team conversations
    ├── Activity / run monitor
    ├── Notes and workspace browser
    ├── Tasks and schedules
    ├── Skills library (post-MVP)
    ├── Approvals queue
    ├── MCP connectors (post-MVP)
    └── Settings and permissions
```

External clients connect to the local HTTP API; the renderer should not
implement a second business-logic path through IPC. IPC is for
Electron-specific needs only, such as window controls and safe desktop
dialogs.

### Suggested package layout

```text
apps/
  desktop/
    src/main/              # Electron main process and composition root
    src/preload/           # Narrow typed bridge
    src/renderer/          # React UI
packages/
  domain/                  # Domain types, IDs, state transitions
  application/             # Use cases and service interfaces
  persistence/             # SQLite repositories and migrations
  agent-runtime/            # Runtime interface and common run lifecycle
  runtime-hermes/           # Optional Hermes adapter
  runtime-opencode/         # Optional OpenCode adapter
  runtime-claude-code/      # Optional Claude Code adapter
  runtime-codex/            # Optional Codex adapter
  api/                     # HTTP routes, schemas, OpenAPI, auth
  shared/                  # Small shared utilities only
```

Do not create every package immediately if the repository is still tiny.
Keep the dependency direction, even if the initial implementation lives
in fewer folders.

## 5. Domain model and ownership

### Core entities

- **Bot** --- stable ID, name, description, persona, runtime
  configuration reference, model preferences, status, timestamps. Its
  persona is written to `AGENTS.md` in its home directory; the runtime
  reads it from there. There is no coordinator role; all bots can
  communicate with all other bots.
- **BotWorkspace** --- bot ID, root directory (the bot's home
  directory). No external project/folder access.
- **Conversation** --- ID, kind (`direct` or `team`), participants,
  title, timestamps.
- **Message** --- ID, conversation ID, sender (human or bot), content,
  optional reply/thread reference, delivery state, timestamp.
- **Task** --- ID, requester, assignee, description, input references,
  priority, status, deadline, result reference.
- **Run** --- ID, bot ID, trigger type, task/conversation reference,
  runtime session reference, lifecycle state, start/end times,
  exit/error summary.
- **ConversationSession** --- ID, conversation ID, runtime session ID,
  last used time, status, created/updated times. Sessions expire after
  30 days of inactivity.
- **Schedule** --- ID, bot ID, trigger definition, task prompt,
  enabled flag, next/last run times, missed-run policy.
- **MemoryItem** --- ID, bot ID, content/reference, free-form tags,
  provenance, created/updated times, optional confidence/expiry.
- **ToolGrant** --- bot ID, app-level tool identifier (messaging,
  tasks, scheduling, approvals), permitted operations, approval policy.
  Filesystem and shell access are governed by home-directory
  confinement and OpenCode defaults, not by ToolGrants.
- **Skill** --- ID, name, description, Markdown content, scope
  (bot or global), provenance, created/updated timestamps.
- **Approval** --- ID, run/task reference, requested action summary,
  requester, status, decision, decided by, timestamps.
- **McpConnector** (post-MVP) --- ID, name, transport/command,
  enabled flag, granted bots, capability metadata.
- **Event** --- ID, event type, entity reference, timestamp,
  payload/version for live delivery and debugging.
- **RuntimeConfig** --- provider/runtime name, executable or
  connection settings, model settings, capability metadata. Secrets
  should be stored separately from ordinary bot profile data.

### Ownership rules

- The **bot service** owns bot identity and configuration validation.
- The **workspace service** owns path validation, filesystem access
  policy, and the filesystem watcher that indexes direct file writes.
- The **conversation session service** owns resumable OpenCode session
  IDs and their lifecycle.
- The **messaging service** owns conversation membership, message
  persistence, and message events.
- The **task service** owns task state transitions and assignment
  rules.
- The **approval service** owns approval requests, decisions, and
  policy evaluation.
- The **skill service** (post-MVP) owns skill CRUD and Markdown
  loading.
- The **MCP connector service** (post-MVP) owns connector lifecycle and
  tool exposure.
- The **run supervisor** owns process lifecycle, cancellation,
  timeouts, output capture, and run state.
- The **scheduler** owns schedule evaluation and durable run
  enqueueing.
- The **runtime adapter** translates a generic run request to one
  specific external runtime and normalizes events/results.
- The **persistence layer** stores state but does not decide domain
  policy.
- The **API layer** validates external input and maps domain errors to
  HTTP responses; it does not implement business rules.

### State machines

Task status should be explicit, for example:

`queued → assigned → running → succeeded | failed | cancelled | awaiting_approval`

Approval status should be explicit, for example:

`pending → approved | rejected | expired`

Define allowed transitions in one place. A run has its own lifecycle and
must not be conflated with task status. A bot can be idle while having
queued tasks, and a task can be waiting for approval while its execution
process is stopped.

## 6. Agent runtime integration

A run does not execute "the bot" directly. The bot's persona lives in
`AGENTS.md` in its home directory, and skills, notes, memory, and logs
live there too; OpenCode discovers them itself. The app launches the
runtime with `cwd` set to the bot's home directory and passes the task
prompt as the initial prompt. Resumable sessions are used by default.

Define one stable internal interface before adding multiple adapters.
For example, conceptually:

```ts
interface AgentRuntime {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;

  startRun(request: RunRequest): Effect.Effect<RunHandle, RuntimeError>;

  cancelRun(handle: RunHandle): Effect.Effect<void, RuntimeError>;

  streamEvents(handle: RunHandle): Stream.Stream<RuntimeEvent, RuntimeError>;

  getResult(handle: RunHandle): Effect.Effect<RunResult, RuntimeError>;
}
```

This is an illustrative contract, not a commitment to exact signatures.
Model it with Effect types and typed failures in implementation.

### Runtime integration plan

1.  **OpenCode is the first runtime** for the end-to-end vertical slice.
    Verify its current CLI/API, session behavior, and non-interactive
    execution support before implementation.
2.  Prefer a documented machine interface (SDK, JSON-RPC, ACP, or
    structured CLI protocol) over parsing human-readable terminal
    output.
3.  Normalize runtime events into internal events such as `run.started`,
    `run.progress`, `run.output`, `run.waiting_for_approval`,
    `run.completed`, and `run.failed`.
4.  Capture the runtime session ID into a `ConversationSession` record
    without making the external runtime session the source of truth for
    bot identity or conversation history. Resume the stored session by
    default; on expiry/failure, start a new session transparently.
    OpenCode runs with the bot's home directory as its working directory
    and uses its default permissions.
5.  Support cancellation, timeout, exit codes, process termination, and
    crash recovery.
6.  Add further adapters only after the common lifecycle and contract
    tests are stable.

Do not assume every runtime supports the same tools, session
persistence, streaming protocol, or non-interactive execution. Represent
capability differences explicitly rather than pretending all adapters
are identical.

## 7. Bot workspaces, notes, and memory

Each bot has a stable home directory, separate from project folders it
may access. This is a folder in a larger directory that has all the bot
folders. The bot's home directory is the working directory in which its
runtime (OpenCode) instance executes; the app assembles the bot's
context and runs the runtime there.

```text
userData/
  app.sqlite
  bots/
    <bot-id>/
      AGENTS.md            # persona (OpenCode auto-loads)
      .opencode/
        skills/
          <skill-id>/
            SKILL.md
      notes/                # one topic per file, ~3000 words max
      memory/               # free-form tagged Markdown files
      logs/                 # agent-written run/conversation summaries
```

The database is the source of truth for structured entities;
Markdown/files are suitable for user-editable notes and documents. Avoid
storing the same mutable fact in both places without a clear authority
rule.

### Initial memory design

- Persona is stored in `AGENTS.md` in the bot's home directory.
- Explicit notes as Markdown files under `notes/` (one topic per file,
  hard limit of ~3000 words; agent resummarizes if over).
- Memory items as free-form tagged Markdown files under `memory/`.
- Conversation history stored in SQLite for the UI/API; agents read
  agent-written summaries under `logs/`.
- Skills as `SKILL.md` files under `.opencode/skills/<id>/`.
- Search over notes, memory, and logs via a filesystem-watcher-
  maintained DB index.
- Agents write these files directly; the app indexes them for search.

Memory is **per bot only**. There is no shared memory across bots;
bots exchange context via messages and tasks. Files belong to a single
bot's home directory.

Do not start with embeddings or a vector database. Add semantic
retrieval only after a real use case demonstrates that text search and
structured memory are insufficient. Keep provenance so a bot can
distinguish a saved fact from a generated inference. Browser sessions are
not retained (browser automation is out of scope).

### Reusable skills (post-MVP)

- Skills follow OpenCode's native format: `SKILL.md` with YAML
  frontmatter (`name`, `description`, optional `metadata.opencode/
autoinvoke`, `disable-model-invocation`) under
  `.opencode/skills/<id>/` in the bot's home directory.
- The app manages skill files and keeps metadata in SQLite for the UI.
- OpenCode discovers and advertises skills; the model loads full bodies
  via OpenCode's `skill` tool.
- Skills may be exported/imported between bots; they are not a shared
  runtime context.

### MCP connectors (post-MVP)

- Connectors are implemented as MCP servers.
- Each connector exposes tools that bots may invoke through the
  runtime, subject to ToolGrants and approval policies.

### Filesystem safety

- Resolve paths against an approved root and reject traversal outside
  it.
- Treat symlinks and platform-specific path behavior carefully;
  lexical prefix checks alone are not sufficient.
- Do not grant all bots access to the entire app data directory.
- Separate read/write access from shell execution permission.
- Require explicit approval for destructive operations, broad
  filesystem access, and external side effects.

## 8. Messaging, teams, and delegation

Bots should communicate through application-owned messages and tasks,
not by directly invoking each other's process.

### Initial capabilities

- Human ↔ bot direct conversations.
- Bot ↔ bot direct messages. When bots start talking, the recipient
  starts a **new** OpenCode session in its home directory, and the
  sending bot's messages are delivered to that session as though they
  came from a user. Bot-to-bot comms are stored as messages.
- User messages may also explicitly mention recipient bots (e.g.
  `@bot`) to bring them into a conversation.
- Team conversations with multiple bot participants.
- Task assignment from one bot to another, including parallel runs
  across multiple bots; tasks trigger runs in the assignee's home.
- All bots can communicate with all other bots; there is no special
  coordinator role. Task delegation is available to any bot.
- Task handoffs between bots with explicit completion criteria.
- Reply/thread references and links to relevant task/run results.
- Resumable OpenCode sessions per conversation (default to last active;
  explicit new session via command/flag).
- Activity timeline showing messages, runs, schedule triggers,
  failures, and approvals.
- Configurable rules for whether bots can initiate messages or only
  reply when triggered.

### Preventing runaway behavior

- Every agent run has a maximum duration and resource budget.
- Bot-to-bot delegation has a maximum depth and/or hop count.
- Message-triggered recipient sessions count as hops and are subject
  to the same limits.
- Bot-to-bot messages start a new recipient session; the sender is
  treated as the user for that session.
- Parallel delegation is bounded by the same depth and concurrency
  limits.
- Add per-bot and global concurrency limits.
- Apply deduplication/idempotency keys to task enqueueing and schedule
  triggers.
- Do not automatically re-trigger a bot on every message it sends
  itself.
- Use explicit task completion criteria and record a terminal result.
- Add a global pause/stop control that prevents new runs and attempts
  to cancel active runs.

## 9. Scheduling and background execution

Schedules must be durable data, not in-memory timers.

### Initial trigger types

- Interval schedule.
- Cron-like schedule with an explicit timezone.
- One-time scheduled run.
- Manual run.

Event-triggered routines (application events, external webhooks) are
deferred; only time-based schedules are supported in initial releases.

### Missed-run policy

- Run all missed occurrences within the last 2 days.
- Skip older missed occurrences but record a "missed" event in the
  activity feed (and notify the user).
- Approval requests expire after 24 hours; a scheduler sweep marks
  them expired.

### Execution behavior

1.  Scheduler checks due schedules.
2.  In a database transaction, it records a schedule occurrence and
    enqueues a run with a unique idempotency key.
3.  A worker claims the queued run.
4.  The run supervisor invokes the selected runtime adapter.
5.  Runtime events and final status are persisted.
6.  The UI/API receives events.
7.  On restart, stale running records are reconciled and due schedules
    are processed according to a documented missed-run policy.

Start with one local worker and a small concurrency limit. Define what
happens if the computer sleeps, the app closes, or the machine is
offline. For the first release, schedules execute only while the
application is running; OS-level launch-at-login can be added later.

## 10. Local API and external connections

The local API is a first-class interface for future integrations.

### API conventions

- Version routes under `/api/v1`.
- Use typed request/response schemas and consistent error envelopes.
- Generate or maintain OpenAPI documentation.
- Use SSE for events and run progress; begin with polling for simple
  status queries.
- Support pagination for messages and activity.
- Add idempotency keys for commands that create runs or send
  externally retried messages.
- Keep internal domain types separate from public API DTOs.

### Security defaults

- Bind to `127.0.0.1` by default.
- Generate a local API token and store it in the OS credential store
  where practical.
- Require authentication for API routes, including routes exposed to
  localhost.
- Never assume every localhost caller is trusted.
- Do not enable LAN or public network binding without explicit user
  configuration and a clear warning.
- Use scoped permissions for external clients, such as read-only
  access versus sending messages or starting runs.
- Avoid logging tokens or secret-bearing environment variables.
- Apply request size limits, validation, and rate limits to expensive
  actions.
- Treat bot output and external content as untrusted data; they must
  not override application policy.

## 11. Electron lifecycle and packaging

- Enforce a single application instance unless multi-instance behavior
  is deliberately designed.
- Start the API, database, scheduler, and worker supervisor in a
  controlled lifecycle.
- Close gracefully: stop accepting new work, persist state, cancel or
  detach runs according to policy, then close resources.
- Use Effect scopes/finalizers for long-lived resources and ensure
  shutdown is idempotent.
- Handle OS sleep/wake and app relaunch.
- Provide a visible API status and a way to rotate/revoke local
  tokens.
- Package and test on the intended OSes; do not assume process
  termination or filesystem behavior is identical across macOS,
  Windows, and Linux.

## 12. Milestones and acceptance criteria

### Milestone 0 --- Scaffold and architecture guardrails

- [x] Create a bun TypeScript workspace with strict settings.
- [x] Set up Electron main, preload, and React renderer.
- [x] Add Effect, lint/format, unit tests, and CI.
- [x] Enforce renderer isolation and a restrictive CSP.
- [x] Document dependency direction and runtime adapter contract.

**Done when:** the packaged/dev app launches, the renderer has no direct
Node access, and CI runs typecheck, lint, and tests.

### Milestone 1 --- Persistent bot directory

- [ ] Add SQLite and versioned migrations.
- [ ] Implement bot CRUD and domain validation.
- [ ] Create and manage bot home directories.
- [ ] Add profile/persona editor and bot list/detail UI.
- [ ] Add repository tests and restart persistence tests.

**Done when:** creating and editing a bot persists across app restarts,
and each bot receives a stable ID and isolated home directory.

### Milestone 2 --- One runtime, one complete run lifecycle

- [ ] Implement the OpenCode runtime adapter.
- [ ] Launch a run with a chosen bot, using its home directory as the
      working directory and its stored session if resumable.
- [ ] Stream or collect output and persist run events.
- [ ] Support cancellation, timeout, exit/error handling, and process
      cleanup.
- [ ] Expose run creation and status through the local API.

**Done when:** a user can trigger a run from the UI and API, observe
progress, cancel it, and inspect the persisted final result after
restarting the app.

### Milestone 3 --- Conversations and bot knowledge

- [ ] Implement direct conversations and message history in SQLite.
- [ ] Write persona to `AGENTS.md`; notes under `notes/`, memory under
      `memory/`, summaries under `logs/`.
- [ ] Add filesystem watcher to index direct file writes for search.
- [ ] Add resumable `ConversationSession` records.
- [ ] Connect conversations to agent runs without conflating their
      identities.

**Done when:** a bot can answer using its configured persona and
relevant saved notes, and the UI can inspect the underlying conversation
and run history.

### Milestone 4 --- Messaging and bounded delegation

- [ ] Add bot-to-bot and team conversations.
- [ ] Trigger recipient sessions on bot-to-bot messages (new session in
      recipient home) and on explicit user mentions.
- [ ] Add task records, assignment, state transitions, and result
      links.
- [ ] Support parallel runs across multiple bots.
- [ ] Provide an application tool/API for bots to send messages and
      create tasks.
- [ ] Add delegation limits, loop prevention, and concurrency
      controls.
- [ ] Add activity feed and global pause/stop behavior.

**Done when:** one bot can assign a bounded task to another, the
recipient can complete it, and the task/result is visible and auditable.

### Milestone 5 --- Durable scheduling

- [ ] Add schedule CRUD and timezone handling.
- [ ] Persist schedule occurrences and queued runs.
- [ ] Implement idempotent enqueueing, retry policy, and missed-run
      behavior.
- [ ] Recover safely from app restart and interrupted executions.
- [ ] Add schedule history and enable/disable controls.

**Done when:** a scheduled bot run fires once per occurrence, survives
application restarts, and reports success or failure in the UI.

### Milestone 6 --- External API and hardening

- [ ] Complete API authentication and scoped tokens.
- [ ] Add SSE, OpenAPI docs, pagination, and idempotency.
- [ ] Implement the approval queue: create, list, approve, reject, and
      expire approvals.
- [ ] Add per-tool and per-action approval policies.
- [ ] Add permission settings and approval gates for risky tools.
- [ ] Test malformed input, process crashes, interrupted writes,
      duplicate requests, and schedule retries.
- [ ] Add packaging, upgrade/migration, backup, and recovery tests.

**Done when:** a separate local client can securely list bots, send
messages, start runs, subscribe to events, and inspect results without
using the UI.

### Later milestones

- Additional runtime adapters.
- Reusable skills as Markdown prompt templates/snippets.
- MCP connectors for external services.
- Event-triggered routines (app events, external webhooks).
- Tool/plugin registry.
- Optional Git integration and safe repository operations.
- OS launch-at-login and sleep/wake handling.
- Semantic memory retrieval if needed.
- Import/export and backups.
- Optional LAN access with explicit authentication and configuration.
- Per-bot sandboxing for higher-risk tools.

## 13. Testing strategy

- **Domain tests:** state transitions, permission decisions,
  delegation limits, idempotency.
- **Repository tests:** migrations, persistence, uniqueness
  constraints, transaction boundaries.
- **Runtime contract tests:** every adapter must pass the same
  lifecycle tests using a fake runtime where possible.
- **Scheduler tests:** timezone boundaries, missed runs, duplicate
  ticks, restarts, retries.
- **API tests:** validation, authentication, authorization, error
  mapping, pagination, SSE behavior.
- **Electron tests:** preload API surface, renderer isolation,
  startup/shutdown.
- **End-to-end tests:** create bot → start run → receive output → save
  notes → schedule run → restart → inspect history.
- **Fault injection:** kill an agent process mid-run, terminate the
  app during a run, simulate database errors, and send duplicate API
  commands.

Use a deterministic fake runtime for most tests. Keep a small number of
smoke tests against a real installed runtime because CLI behavior and
versions can change.

## 14. Key risks and decisions to resolve early

1.  **Runtime protocols differ.** OpenCode is the first runtime; verify
    how it can be driven non-interactively and safely, and how its
    session/model settings are passed.
2.  **Persona vs. runtime instructions.** Persona lives in `AGENTS.md`;
    task prompt is passed as the initial prompt; OpenCode's own
    instructions are appended by the runtime. Conversation history is
    available via DB and agent-written logs.
3.  **Memory ownership.** Agents write notes/memory/logs directly to
    files; the app indexes them. Preserve provenance via file metadata
    and frontmatter; define deletion semantics for indexed files.
4.  **Process survival.** Decide whether active runs stop when the
    desktop app closes or can continue under a separately managed local
    service. MVP default: app lifecycle owns workers, with explicit
    shutdown behavior.
5.  **External API trust.** Localhost is not an authorization boundary;
    use tokens and scopes.
6.  **Filesystem and shell risk.** Path restrictions do not sandbox
    arbitrary shell commands. Add stronger OS-level isolation if bots
    receive broad shell access.
7.  **Scheduling while offline.** Run missed occurrences within 2 days;
    skip older with an activity-feed notification. Approval expiry via
    scheduler sweep.
8.  **Scope creep.** Do not add vector search, multiple databases,
    multi-user accounts, a distributed queue, reusable skills, or MCP
    connectors before the MVP demonstrates a need.
9.  **Approval latency.** Runs waiting for human approval must have a
    clear expiry/timeout policy and must not hold resources indefinitely.

## 15. Definition of MVP

The MVP is complete when a user can:

1.  Launch the Electron application locally.
2.  Create multiple persistent bots with distinct personas and private
    home directories.
3.  Start a run using one supported runtime (OpenCode).
4.  Chat with a bot and inspect its run history.
5.  Save and retrieve notes for each bot.
6.  Let bots send messages and assign bounded tasks to each other.
7.  Schedule a bot to run a task and inspect the result.
8.  Require and resolve human approvals for sensitive actions.
9.  Connect a separate local client through an authenticated API.
10. Restart the application without losing bot profiles, messages,
    notes, tasks, or schedules.
11. Stop runaway work and inspect failures without manually editing the
    database.

Reusable skills, MCP connectors, and event-triggered routines are
explicitly out of scope for the MVP.

The guiding rule is to build a reliable local agent environment first.
Additional models, tools, and integrations should plug into that
foundation without changing the meaning of a bot.
