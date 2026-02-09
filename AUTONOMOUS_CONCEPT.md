# Autonomous Assistant Concept v2 (OpenClaw-Style)

## Objective
Design an assistant that is not just reactive, but continuously self-directed:
- Plans long-horizon work.
- Executes tasks end-to-end.
- Critiques and improves its own output.
- Learns durable project/user patterns.
- Self-manages context growth without collapsing into prompt bloat.
- Feels like a highly capable human operator in conversation and execution.

## North Star
`AGENTS.md` is policy, not memory.

Everything else should be dynamic, searchable, and self-maintained:
- Episodic logs (`what happened`)
- Semantic memory (`what matters`)
- Skills/procedures (`how to do it`)
- Runtime state (`what is running now`)

## Interaction Standard (Human-Level Feel)
The assistant should feel like a very capable human teammate:
- Understand intent quickly and act decisively.
- Communicate in concise, concrete progress updates.
- Confirm assumptions only when ambiguity risks wrong action.
- Preserve continuity ("I remember your stack, style, and current priorities").
- Own end-to-end delivery: plan, build, validate, summarize.

Behavior contract:
1. Default to action over explanation.
2. Provide progress checkpoints for longer tasks.
3. Return outcomes with evidence (files changed, tests run, blockers).
4. Avoid robotic verbosity and repeated boilerplate.
5. When blocked, propose the best fallback and continue.

## System Model (Control Plane + Data Plane)

### Control Plane
Autonomy loop with specialized roles:
1. Planner
- Breaks goals into dependency-aware task graphs.
- Maintains priorities, deadlines, risk, and expected effort.

2. Executor
- Runs tools/code/actions against current task node.
- Produces artifacts and progress events.

3. Critic
- Scores output quality against requirements.
- Detects regressions, incomplete acceptance criteria, and unsafe actions.

4. Curator
- Distills useful learnings from events.
- Promotes or prunes memory/rules via policy gates.

5. Governor
- Enforces boundaries and approval policies.
- Handles rate limits, retry budgets, and interruption control.

### Data Plane
Persistent stores with clear responsibilities:

1. Policy Store (small, stable)
- `.oka/AGENTS.md`
- `.oka/HEARTBEAT.md`

2. Working State
- `.oka/brain/PROCESS-STATE.md`
- `active_task_graph.json` (recommended)
- `run_ledger.jsonl` (recommended append-only execution log)

3. Knowledge Store
- `.oka/brain/LEARNINGS-*.md`
- `.oka/brain/TODOS.md`
- `.oka/memory/YYYY-MM-DD.md`

4. Retrieval Store (scalable)
- Vector/keyword index for relevant recall.
- Convex memory collections or local index (fallback).

5. Skill Store (new)
- Versioned task procedures/templates/checklists.
- Per-skill success/failure metrics and last validated date.

6. Credential Store (new, encrypted)
- Encrypted secrets blob for third-party credentials.
- Access controlled by policy + explicit task need.
- Decryption key sourced from `.env` (never stored in memory files).

## Core Loops

### Loop A: Mission Loop (goal completion)
1. Ingest goal and constraints.
2. Generate task graph with acceptance criteria per node.
3. Execute highest-priority unblocked node.
4. Critic validates node outputs.
5. Mark node done, blocked, or re-plan.
6. Repeat until goal done.

### Loop B: Reflection Loop (self-improvement)
1. Inspect execution ledger.
2. Identify mistakes, bottlenecks, and repeated successful patterns.
3. Convert patterns into:
- skill updates
- memory entries
- optional policy promotions
4. Re-score old rules and prune stale ones.

### Loop C: Heartbeat Loop (autonomous upkeep)
1. Process new events since checkpoint.
2. Refresh priorities and pending commitments.
3. Trigger proactive check-in only when justified.
4. If no meaningful work, return `HEARTBEAT_OK`.

## Memory Strategy (Infinite Growth Without Infinite Context)

### Four Memory Types
1. Episodic Memory
- Raw timeline of tasks/events.
- High volume, append-only.

2. Semantic Memory
- Distilled facts, preferences, conventions.
- Medium volume, curated.

3. Procedural Memory
- Reusable "how-to" playbooks (skills).
- Low volume, high leverage.

4. Working Memory
- Active context for current run only.
- Small, constantly refreshed.

### Retrieval Contract
Never load all memory.
Load only:
- top-k relevant semantic entries
- top-k similar episodes
- 1-3 applicable procedures
- active task graph neighborhood

## Convex Memory Pipeline (Scheduled Collect + Dump)
Yes, this is the right direction. Make Convex the cloud memory backend and keep markdown as local source-of-truth snapshots.

### Architecture
1. Local Event Source
- `.oka/memory/YYYY-MM-DD.md`
- `run_ledger.jsonl`
- `.oka/brain/LEARNINGS-*.md`

2. ETL Worker (scheduled)
- Runs every N minutes (for example every 5-15 min).
- Reads only new data since last checkpoint.
- Chunks, normalizes, embeds, and upserts to Convex.

3. Convex Collections (recommended)
- `events` (raw normalized events)
- `memories` (distilled semantic items)
- `procedures` (skill entries)
- `artifacts` (references to generated files/results)
- `checkpoints` (last processed local offsets)

4. Query-time Retrieval Layer
- For each Telegram message, embed query + fetch top-k from Convex first.
- Build compact context pack from retrieved items.
- Inject that pack into Codex prompt instead of full markdown history.

### Why This Improves Quality
- Better relevance: semantic recall beats chronological markdown dumps.
- Smaller prompts: only task-relevant memory is included.
- Better continuity: memories remain available across long histories.
- Safer scaling: memory growth moves to index/storage, not prompt size.

### Scheduler Design
Two jobs:
1. `collect_and_dump` (frequent)
- Pull local deltas -> Convex upsert.

2. `distill_and_prune` (less frequent)
- Re-score memory quality.
- Merge duplicates.
- Archive stale/superseded entries.

Checkpoint keys:
- `last_event_offset`
- `last_memory_file_position`
- `last_distill_at`

### Telegram Request Flow (Retrieval-First)
1. User message arrives.
2. Classify intent + derive retrieval query.
3. Query Convex:
- semantic memories (k1)
- recent related events (k2)
- matching procedures/skills (k3)
4. Build `ContextPack` (token-capped, deduped, ranked).
5. Call Codex with:
- policy prompt (`AGENTS.md` essentials)
- current user message
- `ContextPack` only
6. Execute actions.
7. Append execution events locally and schedule async dump to Convex.

### ContextPack Contract (token-efficient)
`ContextPack` fields:
- `active_goals`
- `relevant_facts`
- `relevant_preferences`
- `similar_past_tasks`
- `applicable_procedures`
- `open_blockers`
- `credential_hints` (non-secret references only)

Hard limits:
- max items per section
- max total tokens
- drop lowest-score items first

### Failure Strategy
- If Convex is unavailable: fallback to local markdown retrieval.
- If embeddings fail: fallback to keyword + recency ranking.
- If no memory matches: run with minimal policy + current message.

### Security Notes for Convex
- Never upload plaintext secrets.
- Store only references/ids for credential usage, never secret values.
- Encrypt sensitive memory fields before upload if needed.
- Use tenant/user scoping in queries to prevent cross-user leakage.

### Token Efficiency Contract
Hard rules to keep runtime token usage low:
1. Budget by phase:
- planning: small context window
- execution: task-local context only
- reflection: batch mode over compact logs
2. Use references, not full payloads:
- store raw outputs in files, pass summaries + paths
3. Summarize-on-write:
- every long artifact gets a short synopsis entry for future retrieval
4. Top-k recall:
- retrieve only best matching entries per category
5. Prompt compaction:
- dedupe repeated constraints
- strip stale history
- keep only active goals + active blockers + relevant conventions
6. Sliding working memory:
- fixed-size active context, older context auto-demoted to retrieval layer

## Self-Modification Policy (Powerful but Safe)

### Promotion Gate
A rule/procedure can be promoted only if:
1. Repeated evidence (at least 3 independent occurrences).
2. Demonstrated impact (quality/speed/safety gain).
3. Stability (not contradicted recently).
4. Auditability (source events linked).

### Update Destinations
- `AGENTS.md`: only durable, project-wide policy.
- `HEARTBEAT.md`: maintenance/process behavior only.
- `Skill Store`: task execution procedures.
- `LEARNINGS-*`: user/project-specific evolving facts.

### Automatic Pruning
Each entry carries:
- confidence
- last_validated_at
- ttl/review_at
- superseded_by (optional)

Expired or contradicted entries are archived, not hard-deleted.

## Credential System (Encrypted)
Goal: assistant can "do whatever is needed" across services without leaking secrets.

### Key Management
- `.env`:
  - `CREDENTIALS_MASTER_KEY=` base64 key (32 bytes for AES-256-GCM).
  - `CREDENTIALS_KDF_SALT=` optional salt if deriving from passphrase.
- Never write plaintext credentials to `.oka/memory` or `LEARNINGS-*`.
- Rotate keys with re-encryption migration job.

### Storage Layout (recommended)
- `.oka/secure/credentials.enc.json` (encrypted payloads only)
- `.oka/secure/credentials.meta.json` (non-secret metadata: provider, scope, updated_at)

### Credential Record Shape
- `id`
- `provider` (github, supabase, slack, etc.)
- `account_hint` (non-sensitive identifier)
- `scopes`
- `ciphertext`
- `iv`
- `auth_tag`
- `created_at`
- `updated_at`
- `last_used_at`
- `status` (`active|revoked|expired`)

### Access Policy
1. Least privilege: fetch only credential needed for current task.
2. Just-in-time decryption: decrypt in memory, zero buffers after use.
3. Audit trail: append credential usage event to `run_ledger.jsonl` without secret values.
4. Revocation-aware: refuse use of revoked/expired credentials.
5. Human override path for sensitive external side effects.

## OpenClaw-Style Capabilities to Add
1. Task Graph Engine
- DAG with dependency tracking, blockers, retries, and rollback hints.

2. Multi-Agent Internal Delegation
- Planner/Executor/Critic as separate sub-agents with bounded scopes.

3. Skill Compiler
- Convert successful trajectories into reusable procedures.

4. Environment Model
- Keep repo/toolchain/service map and update when structure changes.

5. Evaluator Harness
- Continuous scoring for task success, test pass rate, and user correction rate.

6. Adaptive Autonomy Level
- `manual`, `guided`, `autonomous`.
- Automatically downgrade autonomy after repeated critic failures.

7. Secure Tooling Layer
- Credential broker with encrypted at-rest storage and auditable access.

## Codex Role Implementation Decision
Planner/Executor/Critic/Curator/Governor will be implemented with a hybrid model: markdown role definitions + code-level orchestration and validation.

### Option B: Hybrid (Markdown + Code Orchestrator) (recommended)
Keep markdown role prompts, but enforce machine-validated output in code.

Required artifacts:
- `.oka/roles/PLANNER.md`
- `.oka/roles/EXECUTOR.md`
- `.oka/roles/CRITIC.md`
- `.oka/roles/CURATOR.md`
- `.oka/roles/GOVERNOR.md`
- `orchestrator.ts` (role runner + transition engine)
- `schemas/*.json` (role output contracts)
- `run_ledger.jsonl` (append-only event stream)

Execution contract:
1. Role prompt defines scope, constraints, and output schema id.
2. `orchestrator.ts` invokes Codex with task-local context only.
3. Response must parse as JSON and pass schema validation.
4. Invalid output triggers auto-repair attempt, then controlled fail.
5. Valid output is persisted as event + transition decision.
6. Governor enforces approvals, retry budgets, and side-effect policy.

Minimal state machine:
- `PLANNING -> EXECUTING -> CRITIQUE -> (REPLAN|CURATE|DONE)`

This gives OpenClaw-style rigor while keeping behavior editable in markdown.

## Example Flow: "Build a Task Management Dashboard"
1. Planner creates graph:
- requirements capture
- data model
- UI scaffold
- API wiring
- tests
- docs
2. Executor completes nodes with artifacts.
3. Critic checks acceptance criteria after each node.
4. Curator extracts:
- preferred UI style
- chosen stack and patterns
- pitfalls encountered
5. Curator updates:
- procedure in Skill Store
- learnings in `.oka/brain/LEARNINGS-AI.md`
- follow-ups in `.oka/brain/TODOS.md`
6. Similar future request reuses procedure + retrieved conventions.

## Minimal Implementation Plan (Practical)
1. Define machine contracts:
- add `schemas/` for planner/executor/critic/curator/governor outputs
- add `.oka/brain/SCHEMA.md` for memory + credential metadata
2. Add role prompts under `.oka/roles/*.md` aligned to schema ids.
3. Implement `orchestrator.ts`:
- role invocation
- schema validation
- transition engine
- retry/fail handling
4. Add persistent runtime files:
- `active_task_graph.json`
- `run_ledger.jsonl`
- transition/error audit events
5. Add Governor enforcement:
- approval gates for sensitive actions
- retry budgets and autonomy downgrade rules
6. Add retrieval API (`get_relevant_context(goal, k)`) with strict token caps.
7. Extend heartbeat for Reflection + Pruning jobs.
8. Add skill compiler from repeated successful trajectories.

## Success Metrics
- Goal completion rate.
- Median time-to-completion.
- Rework rate (critic rejections).
- User correction rate per task.
- Memory precision (retrieved entries actually used).
- Prompt footprint stability as memory corpus grows.

## Definition of "More Powerful"
The assistant is "OpenClaw-class" when it can:
1. Run long-horizon tasks with minimal supervision.
2. Build and reuse procedural skills automatically.
3. Continuously improve from its own execution traces.
4. Scale memory indefinitely while keeping runtime context compact.
5. Stay safe through policy gates, critic loops, and auditable changes.
