# Autonomous Assistant Concept v3 (Lean)

## Objective
Build an assistant that can complete real tasks end-to-end with minimal supervision, while staying auditable and safe.

## Design Rules
1. Reliability over sophistication.
2. One source of truth per concern.
3. Retrieval-first context, never full-history prompts.
4. Policy in markdown, control in code.
5. Local-first operation with cloud sync as optional acceleration.
6. Immutable base container, mutable user-space tools.

## Non-Goals (v3)
- No full multi-agent swarm.
- No autonomous policy rewriting.
- No hard dependency on cloud memory to function.

## Core Architecture

### Roles (3 only)
1. Planner
- Produces a small task graph with acceptance criteria.

2. Executor
- Executes the next unblocked task and records artifacts.

3. Critic
- Validates outputs against acceptance criteria and safety checks.

`Governor` and `Curator` are implemented as deterministic orchestration logic, not free-form LLM roles.

### State Machine
`PLAN -> EXECUTE -> CRITIQUE -> (REPLAN | DONE)`

### Loops (2 only)
1. Request Loop (synchronous)
- Triggered by user input.
- Runs the state machine until done, blocked, or handoff needed.

2. Maintenance Loop (scheduled)
- Compacts memory, scores procedures, archives stale entries.

## Data Model (Minimal)

### Canonical Runtime Files
1. `run_ledger.jsonl`
- Append-only event log for all decisions/actions.

2. `active_task_graph.json`
- Current goal graph and node status.

### Derived Files
1. `.oka/brain/LEARNINGS-*.md`
2. `.oka/brain/TODOS.md`
3. `.oka/memory/YYYY-MM-DD.md`

Derived files are summaries generated from canonical logs. They are not the authority for orchestration decisions.

## Memory Strategy (Lean)

### Memory Types
1. Episodic: events from `run_ledger.jsonl`
2. Semantic: distilled facts/preferences
3. Procedural: reusable playbooks

### Retrieval Contract
Load only:
- active task graph neighborhood
- top-k semantic facts
- top-k related episodes
- up to 3 procedures

Hard cap:
- fixed token budget for context pack
- lowest-score items dropped first

## Storage and Retrieval

### v3 Default: Local-First
- Local keyword + embedding index.
- Works without external services.

### Optional Cloud Sync
- Convex (or equivalent) receives async replicated memory/events.
- If cloud is down, assistant behavior is unchanged; only recall quality may degrade.

## Safety and Control

### Deterministic Guardrails
1. Allow/deny tool policy by action type.
2. Side-effect classes: `read`, `write_local`, `external_mutation`.
3. Approval required for high-risk external mutations.
4. Retry budgets per node and per run.

### Credential Handling
- Encrypted credential store at rest.
- Just-in-time decryption in memory only.
- Usage logged to `run_ledger.jsonl` without secret values.

## Skill System (Practical)

### Procedure Promotion Gate
Promote a procedure only when:
1. At least 3 successful independent executions.
2. Better outcome than baseline (speed, quality, or safety).
3. No recent contradictions.

### Procedure Shape
- Trigger conditions
- Ordered steps
- Known pitfalls
- Validation checklist
- Last validated timestamp

## Docker Compose Reality

### Can it run fully in Compose?
Yes. Bot, scheduler, and optional retrieval service can run in containers with mounted workspace/state volumes.

### Can it install software on demand?
Yes, in v3 via user-space installs only (no root package manager, no host installs).

Key constraints:
1. Installs must target mounted paths (for example `.oka/tools`) to survive container restarts.
2. It cannot install software on the host by default.
3. OS-level packages still require Dockerfile/image updates.
4. Mounting Docker socket is out of scope for v3 due to risk.

### Environment Self-Management (Chosen v3 mode)
The assistant can self-manage dependencies in user space with a strict contract.

Install locations:
- `.oka/tools/bin` for standalone binaries
- `.oka/tools/python` for virtualenvs
- `.oka/tools/node` for npm/pnpm global-style prefixes

Runtime behavior:
1. Detect missing dependency from execution failure.
2. Attempt user-space install into `.oka/tools/*`.
3. Re-run the failed step.
4. If successful, record install event in `run_ledger.jsonl`.
5. If install requires root/OS package, write a request file and continue with fallback.

PATH contract:
- Orchestrator prepends `.oka/tools/bin` and relevant tool-specific bin paths before task execution.
- Never mutate system paths outside workspace-controlled directories.

Escalation file (for image-level deps):
- `INSTALL_REQUIREMENTS.md` in workdir, with:
  - dependency name
  - blocking task
  - failure evidence
  - suggested Dockerfile snippet
  - status (`open|resolved`)

### Recommended Runtime Pattern
1. Keep main bot container mostly immutable.
2. Let assistant auto-install user-space tools into mounted workspace paths.
3. Escalate OS-level dependencies via `INSTALL_REQUIREMENTS.md` for human-reviewed image updates.

## Implementation Plan (Lean Sequence)
1. Add schemas for planner/executor/critic outputs.
2. Build orchestrator with strict JSON validation and retry limits.
3. Persist canonical files: `run_ledger.jsonl`, `active_task_graph.json`.
4. Add local retrieval index + context pack builder with token caps.
5. Add dependency manager:
   - detect missing tools
   - install into `.oka/tools/*`
   - prepend runtime PATH
   - write `INSTALL_REQUIREMENTS.md` for OS-level blockers
6. Add maintenance loop for distill/prune/procedure scoring.
7. Add optional cloud replication worker.

## Success Metrics
1. Task completion rate.
2. Rework rate (critic rejection ratio).
3. Median time-to-completion.
4. User correction rate.
5. Context pack token stability over growing history.

## v3 Definition of Powerful
The assistant is powerful enough when it can:
1. Complete multi-step tasks with minimal user intervention.
2. Reuse proven procedures across similar tasks.
3. Maintain stable quality as history grows.
4. Operate safely with auditable decisions and bounded autonomy.
