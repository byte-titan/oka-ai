import { spawn } from "bun";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "fs/promises";
import { join } from "path";
import {
  ActiveTaskGraphState,
  ActiveTaskNodeState,
  AutonomousRuntimeConfig,
  SideEffectClass,
  WorkspacePaths,
  appendRunLedgerEvent,
  buildWorkspacePathEnv,
  loadAutonomousConfig,
} from "./workspace";

interface PlannerTask {
  id: string;
  title: string;
  depends_on: string[];
  acceptance_criteria: string[];
  risk: "low" | "medium" | "high";
  side_effect: SideEffectClass;
}

interface PlannerOutput {
  summary: string;
  tasks: PlannerTask[];
}

interface ExecutorDependencyHint {
  name: string;
  install_command?: string;
  requires_root?: boolean;
  evidence?: string;
}

interface ExecutorOutput {
  task_id: string;
  status: "done" | "blocked" | "failed";
  result_summary: string;
  artifacts: string[];
  needs_replan?: boolean;
  missing_dependency?: ExecutorDependencyHint;
}

interface CriticOutput {
  task_id: string;
  verdict: "pass" | "retry" | "replan" | "block";
  issues: string[];
  suggested_fix: string;
}

interface ContextPack {
  active_goals: string[];
  relevant_facts: string[];
  related_episodes: string[];
  applicable_procedures: string[];
  open_blockers: string[];
}

export interface AutonomousCodexRunner {
  callCodex(prompt: string, options?: { resume?: boolean }): Promise<string>;
}

export interface AutonomousRunResult {
  response: string;
  graph: ActiveTaskGraphState;
}

const FALLBACK_TASK_ID = "task-1";
const NO_DEPENDENCY_SENTINELS = new Set([
  "none",
  "no",
  "n/a",
  "na",
  "null",
  "nil",
  "false",
  "not_applicable",
  "not-applicable",
  "no_dependency",
  "no-dependency",
  "no missing dependency",
]);

function parseJsonObject<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    // Continue and try extracting the first object-shaped region.
  }

  const first = input.indexOf("{");
  const last = input.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    return null;
  }

  try {
    return JSON.parse(input.slice(first, last + 1)) as T;
  } catch {
    return null;
  }
}

function sanitizeTaskId(raw: string, index: number): string {
  const trimmed = raw.trim().toLowerCase();
  const normalized = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) return `task-${index + 1}`;
  if (!normalized.startsWith("task-")) {
    return `task-${normalized}`;
  }
  return normalized;
}

function clampStringArray(values: unknown, maxItems: number): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeDependencyName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (NO_DEPENDENCY_SENTINELS.has(normalized)) return null;
  return trimmed;
}

function validatePlannerOutput(
  raw: PlannerOutput | null,
  goal: string,
  config: AutonomousRuntimeConfig
): PlannerOutput {
  if (!raw || typeof raw !== "object") {
    return {
      summary: "Fallback single-task plan due to invalid planner output.",
      tasks: [
        {
          id: FALLBACK_TASK_ID,
          title: goal,
          depends_on: [],
          acceptance_criteria: ["Provide a concrete answer to the user request."],
          risk: "low",
          side_effect: "read",
        },
      ],
    };
  }

  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const uniqueIds = new Set<string>();
  const idMap = new Map<string, string>();
  const draftTasks: Array<
    Omit<PlannerTask, "depends_on"> & {
      raw_depends_on: string[];
    }
  > = [];

  for (let i = 0; i < rawTasks.length; i += 1) {
    const task = rawTasks[i] as Partial<PlannerTask>;
    const rawId = typeof task.id === "string" ? task.id.trim() : `task-${i + 1}`;
    const id = sanitizeTaskId(rawId, i);
    if (uniqueIds.has(id)) continue;
    uniqueIds.add(id);
    idMap.set(rawId, id);
    idMap.set(id, id);

    const title = typeof task.title === "string" ? task.title.trim() : "";
    if (!title) continue;

    const sideEffect =
      task.side_effect === "read" ||
      task.side_effect === "write_local" ||
      task.side_effect === "external_mutation"
        ? task.side_effect
        : "read";
    const risk = task.risk === "high" || task.risk === "medium" || task.risk === "low" ? task.risk : "low";

    draftTasks.push({
      id,
      title,
      raw_depends_on: clampStringArray(task.depends_on, 6),
      acceptance_criteria: clampStringArray(task.acceptance_criteria, 6),
      risk,
      side_effect: sideEffect,
    });
  }

  const tasks = draftTasks.map<PlannerTask>((task) => {
    const resolvedDependencies = task.raw_depends_on
      .map((dependencyId) => {
        const directMatch = idMap.get(dependencyId);
        if (directMatch) return directMatch;
        return idMap.get(sanitizeTaskId(dependencyId, 0)) || null;
      })
      .filter((dependencyId): dependencyId is string => Boolean(dependencyId))
      .filter((dependencyId, index, items) => items.indexOf(dependencyId) === index)
      .filter((dependencyId) => dependencyId !== task.id);

    return {
      id: task.id,
      title: task.title,
      depends_on: resolvedDependencies,
      acceptance_criteria: task.acceptance_criteria,
      risk: task.risk,
      side_effect: task.side_effect,
    };
  });

  if (tasks.length === 0) {
    return {
      summary: "Fallback single-task plan because planner returned no valid tasks.",
      tasks: [
        {
          id: FALLBACK_TASK_ID,
          title: goal,
          depends_on: [],
          acceptance_criteria: ["Provide a concrete answer to the user request."],
          risk: "low",
          side_effect: "read",
        },
      ],
    };
  }

  return {
    summary: raw.summary || "Task plan generated.",
    tasks: tasks.slice(0, config.max_tasks_per_plan),
  };
}

function validateExecutorOutput(raw: ExecutorOutput | null, taskId: string): ExecutorOutput {
  if (!raw || typeof raw !== "object") {
    return {
      task_id: taskId,
      status: "failed",
      result_summary: "Executor response was invalid JSON.",
      artifacts: [],
    };
  }

  const status = raw.status === "done" || raw.status === "blocked" || raw.status === "failed" ? raw.status : "failed";
  const missingDependencyName =
    raw.missing_dependency && typeof raw.missing_dependency === "object"
      ? normalizeDependencyName(raw.missing_dependency.name)
      : null;
  const missingDependency =
    raw.missing_dependency &&
    typeof raw.missing_dependency === "object" &&
    missingDependencyName
      ? {
          name: missingDependencyName,
          install_command:
            typeof raw.missing_dependency.install_command === "string"
              ? raw.missing_dependency.install_command.trim()
              : undefined,
          requires_root: Boolean(raw.missing_dependency.requires_root),
          evidence:
            typeof raw.missing_dependency.evidence === "string"
              ? raw.missing_dependency.evidence.trim()
              : undefined,
        }
      : undefined;

  return {
    task_id: raw.task_id || taskId,
    status,
    result_summary:
      typeof raw.result_summary === "string" && raw.result_summary.trim()
        ? raw.result_summary.trim()
        : "Executor finished without summary.",
    artifacts: clampStringArray(raw.artifacts, 8),
    needs_replan: Boolean(raw.needs_replan),
    missing_dependency: missingDependency,
  };
}

function validateCriticOutput(raw: CriticOutput | null, taskId: string): CriticOutput {
  if (!raw || typeof raw !== "object") {
    return {
      task_id: taskId,
      verdict: "retry",
      issues: ["Critic response was invalid JSON."],
      suggested_fix: "Return strict JSON with a verdict.",
    };
  }

  const verdict =
    raw.verdict === "pass" || raw.verdict === "retry" || raw.verdict === "replan" || raw.verdict === "block"
      ? raw.verdict
      : "retry";

  return {
    task_id: raw.task_id || taskId,
    verdict,
    issues: clampStringArray(raw.issues, 8),
    suggested_fix: typeof raw.suggested_fix === "string" ? raw.suggested_fix.trim() : "",
  };
}

async function loadTaskGraph(paths: WorkspacePaths): Promise<ActiveTaskGraphState> {
  try {
    const content = await readFile(paths.activeTaskGraphFile, "utf-8");
    const parsed = JSON.parse(content) as ActiveTaskGraphState;
    if (parsed && parsed.version === "v3" && Array.isArray(parsed.nodes)) {
      return parsed;
    }
  } catch {
    // Fallback below.
  }

  const now = new Date().toISOString();
  return {
    version: "v3",
    run_id: null,
    goal: "",
    status: "done",
    summary: "",
    nodes: [],
    current_task_id: null,
    created_at: now,
    updated_at: now,
  };
}

async function saveTaskGraph(paths: WorkspacePaths, graph: ActiveTaskGraphState): Promise<void> {
  graph.updated_at = new Date().toISOString();
  await writeFile(paths.activeTaskGraphFile, `${JSON.stringify(graph, null, 2)}\n`, "utf-8");
}

async function readLines(pathValue: string): Promise<string[]> {
  try {
    const content = await readFile(pathValue, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function scoreEpisode(line: string, keywords: string[]): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) score += 1;
  }
  return score;
}

async function buildContextPack(
  paths: WorkspacePaths,
  goal: string,
  config: AutonomousRuntimeConfig
): Promise<ContextPack> {
  const todoLines = await readLines(paths.todosFile);
  const learningLines = await readLines(paths.learningsFile);
  const procedureLines = await readLines(paths.proceduresFile);
  const runLedgerLines = await readLines(paths.runLedgerFile);
  const currentGraph = await loadTaskGraph(paths);

  const activeGoals = todoLines
    .filter((line) => /^[-*]\s+\[\s\]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+\[\s\]\s+/, "").trim())
    .slice(0, 6);

  const relevantFacts = learningLines
    .filter((line) => line.startsWith("- "))
    .slice(0, config.context_pack.max_relevant_facts);

  const procedures = procedureLines
    .filter((line) => line.startsWith("## "))
    .map((line) => line.replace(/^##\s+/, "").trim())
    .slice(0, config.context_pack.max_procedures);

  const openBlockers = currentGraph.nodes
    .filter((node) => node.status === "blocked")
    .map((node) => `${node.id}: ${node.title}`)
    .slice(0, 5);

  const keywords = goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4)
    .slice(0, 12);

  const relatedEpisodes = runLedgerLines
    .map((line) => ({ line, score: scoreEpisode(line, keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.context_pack.max_related_episodes)
    .map((entry) => entry.line);

  return {
    active_goals: activeGoals,
    relevant_facts: relevantFacts,
    related_episodes: relatedEpisodes,
    applicable_procedures: procedures,
    open_blockers: openBlockers,
  };
}

function buildPlannerPrompt(goal: string, contextPack: ContextPack, config: AutonomousRuntimeConfig): string {
  return [
    "Role: Planner.",
    "Create a small dependency-aware task graph for the goal.",
    "Output strict JSON only. No markdown, no prose.",
    `Hard limits: max ${config.max_tasks_per_plan} tasks.`,
    "Schema:",
    "{",
    '  "summary": "string",',
    '  "tasks": [',
    "    {",
    '      "id": "task-id",',
    '      "title": "string",',
    '      "depends_on": ["task-id"],',
    '      "acceptance_criteria": ["string"],',
    '      "risk": "low|medium|high",',
    '      "side_effect": "read|write_local|external_mutation"',
    "    }",
    "  ]",
    "}",
    `Goal: ${goal}`,
    `ContextPack: ${JSON.stringify(contextPack, null, 2)}`,
  ].join("\n");
}

function buildExecutorPrompt(
  goal: string,
  task: ActiveTaskNodeState,
  contextPack: ContextPack,
  config: AutonomousRuntimeConfig,
  paths: WorkspacePaths
): string {
  return [
    "Role: Executor.",
    "Execute only the given task and return strict JSON only.",
    "You can write local files inside workspace paths when needed.",
    "If a dependency is missing, return missing_dependency object with install_command.",
    "If no dependency is missing, set missing_dependency to null.",
    "User-space install targets:",
    `- ${paths.toolsBinDir}`,
    `- ${paths.toolsPythonDir}`,
    `- ${paths.toolsNodeDir}`,
    "Schema:",
    "{",
    `  "task_id": "${task.id}",`,
    '  "status": "done|blocked|failed",',
    '  "result_summary": "string",',
    '  "artifacts": ["path"],',
    '  "needs_replan": false,',
    '  "missing_dependency": null | {',
    '    "name": "string",',
    '    "install_command": "string",',
    '    "requires_root": false,',
    '    "evidence": "string"',
    "  }",
    "}",
    `Policy allow_external_mutation=${config.policy.allow_external_mutation ? "true" : "false"}`,
    `Goal: ${goal}`,
    `Task: ${JSON.stringify(task, null, 2)}`,
    `ContextPack: ${JSON.stringify(contextPack, null, 2)}`,
  ].join("\n");
}

function buildCriticPrompt(
  goal: string,
  task: ActiveTaskNodeState,
  execution: ExecutorOutput,
  contextPack: ContextPack
): string {
  return [
    "Role: Critic.",
    "Validate executor output against acceptance criteria and safety constraints.",
    "Return strict JSON only.",
    "Schema:",
    "{",
    `  "task_id": "${task.id}",`,
    '  "verdict": "pass|retry|replan|block",',
    '  "issues": ["string"],',
    '  "suggested_fix": "string"',
    "}",
    `Goal: ${goal}`,
    `Task: ${JSON.stringify(task, null, 2)}`,
    `Execution: ${JSON.stringify(execution, null, 2)}`,
    `ContextPack: ${JSON.stringify(contextPack, null, 2)}`,
  ].join("\n");
}

function getNextRunnableTask(nodes: ActiveTaskNodeState[]): ActiveTaskNodeState | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.status !== "pending") continue;
    const depsMet = node.depends_on.every((depId) => byId.get(depId)?.status === "done");
    if (depsMet) return node;
  }
  return null;
}

function summarizeGraph(graph: ActiveTaskGraphState): string {
  const done = graph.nodes.filter((node) => node.status === "done");
  const blocked = graph.nodes.filter((node) => node.status === "blocked");
  const failed = graph.nodes.filter((node) => node.status === "failed");

  const completedLines = done.map((node) => `- ${node.title}: ${node.result_summary || "completed"}`);
  const blockedLines = blocked.map((node) => {
    const reason = node.critic_issues?.[0] || "blocked";
    return `- ${node.title}: ${reason}`;
  });
  const failedLines = failed.map((node) => {
    const reason = node.critic_issues?.[0] || "failed";
    return `- ${node.title}: ${reason}`;
  });

  const parts: string[] = [];
  if (completedLines.length > 0) {
    parts.push("Completed:");
    parts.push(...completedLines);
  }
  if (blockedLines.length > 0) {
    parts.push("");
    parts.push("Blocked:");
    parts.push(...blockedLines);
  }
  if (failedLines.length > 0) {
    parts.push("");
    parts.push("Failed:");
    parts.push(...failedLines);
  }

  if (parts.length === 0) {
    return "No executable tasks were completed.";
  }

  return parts.join("\n").trim();
}

function includesRootLevelInstall(command: string): boolean {
  return /\b(sudo|apt(-get)?|yum|dnf|pacman|apk|brew|choco|winget)\b/i.test(command);
}

interface DependencyInstallResult {
  status: "installed" | "failed" | "escalated";
  details: string;
}

async function appendInstallRequirement(
  paths: WorkspacePaths,
  task: ActiveTaskNodeState,
  dependency: ExecutorDependencyHint
): Promise<void> {
  const snippet = dependency.install_command
    ? `# Suggested\n# ${dependency.install_command}\n`
    : "# Suggested\n# Add required OS package to your image.\n";
  const entry = [
    "",
    `### Dependency: ${dependency.name || "unknown"}`,
    "- status: open",
    `- blocking_task: ${task.id} (${task.title})`,
    `- failure_evidence: ${(dependency.evidence || "missing dependency").replace(/\n/g, " ")}`,
    "- suggested_dockerfile_snippet:",
    "```dockerfile",
    snippet.trimEnd(),
    "```",
    `- opened_at: ${new Date().toISOString()}`,
    "- resolved_at:",
    "",
  ].join("\n");
  await appendFile(paths.installRequirementsFile, entry, "utf-8");
}

async function attemptUserSpaceInstall(
  paths: WorkspacePaths,
  task: ActiveTaskNodeState,
  dependency: ExecutorDependencyHint
): Promise<DependencyInstallResult> {
  const command = dependency.install_command || "";
  const requiresRoot = Boolean(dependency.requires_root) || includesRootLevelInstall(command);
  if (!command || requiresRoot) {
    await appendInstallRequirement(paths, task, dependency);
    return {
      status: "escalated",
      details: `Escalated ${dependency.name} to ${paths.installRequirementsFile}`,
    };
  }

  try {
    const proc = spawn(["sh", "-lc", command], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: paths.workspaceDir,
      env: {
        ...process.env,
        PATH: buildWorkspacePathEnv(paths),
        PIP_PREFIX: paths.toolsPythonDir,
        PYTHONUSERBASE: paths.toolsPythonDir,
        npm_config_prefix: paths.toolsNodeDir,
      },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      return {
        status: "installed",
        details: `${dependency.name} installed with command: ${command}`,
      };
    }

    return {
      status: "failed",
      details: `Install failed (${dependency.name}): ${stderr || stdout || `exit ${exitCode}`}`,
    };
  } catch (error) {
    return {
      status: "failed",
      details: `Install failed (${dependency.name}): ${String(error)}`,
    };
  }
}

function mergeReplanIntoGraph(
  graph: ActiveTaskGraphState,
  plan: PlannerOutput
): ActiveTaskNodeState[] {
  const completed = graph.nodes.filter((node) => node.status === "done");
  const completedIds = new Set(completed.map((node) => node.id));

  const replanned = plan.tasks
    .filter((task) => !completedIds.has(task.id))
    .map<ActiveTaskNodeState>((task) => ({
      id: task.id,
      title: task.title,
      status: "pending",
      depends_on: task.depends_on,
      acceptance_criteria: task.acceptance_criteria,
      retries: 0,
      risk: task.risk,
      side_effect: task.side_effect,
    }));

  return [...completed, ...replanned];
}

export async function runAutonomousV3(
  message: string,
  paths: WorkspacePaths,
  runner: AutonomousCodexRunner
): Promise<AutonomousRunResult> {
  const config = await loadAutonomousConfig(paths);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  let graph: ActiveTaskGraphState = {
    version: "v3",
    run_id: runId,
    goal: message,
    status: "planning",
    summary: "",
    nodes: [],
    current_task_id: null,
    created_at: now,
    updated_at: now,
  };

  await saveTaskGraph(paths, graph);
  await appendRunLedgerEvent(paths, {
    event: "run.started",
    run_id: runId,
    actor: "governor",
    status: "ok",
    message: message.slice(0, 500),
  });

  const initialContextPack = await buildContextPack(paths, message, config);
  const plannerPrompt = buildPlannerPrompt(message, initialContextPack, config);
  const plannerRaw = await runner.callCodex(plannerPrompt, { resume: false });
  const planner = validatePlannerOutput(parseJsonObject<PlannerOutput>(plannerRaw), message, config);

  graph.summary = planner.summary;
  graph.nodes = planner.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: "pending",
    depends_on: task.depends_on,
    acceptance_criteria: task.acceptance_criteria,
    retries: 0,
    risk: task.risk,
    side_effect: task.side_effect,
  }));
  graph.status = "executing";
  await saveTaskGraph(paths, graph);
  await appendRunLedgerEvent(paths, {
    event: "plan.created",
    run_id: runId,
    actor: "planner",
    status: "ok",
    message: planner.summary,
    data: {
      task_count: graph.nodes.length,
      task_ids: graph.nodes.map((task) => task.id),
    },
  });

  let replanCount = 0;
  const maxIterations = Math.max(
    4,
    graph.nodes.length * (config.retry_budget_per_node + config.replan_budget_per_run + 2)
  );

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const nextTask = getNextRunnableTask(graph.nodes);

    if (!nextTask) {
      const hasPending = graph.nodes.some((node) => node.status === "pending" || node.status === "in_progress");
      if (!hasPending) {
        const hasFailures = graph.nodes.some(
          (node) => node.status === "blocked" || node.status === "failed"
        );
        graph.status = hasFailures ? "blocked" : "done";
      } else {
        graph.status = "blocked";
      }
      graph.current_task_id = null;
      await saveTaskGraph(paths, graph);
      break;
    }

    graph.status = "executing";
    graph.current_task_id = nextTask.id;
    nextTask.status = "in_progress";
    await saveTaskGraph(paths, graph);
    await appendRunLedgerEvent(paths, {
      event: "task.started",
      run_id: runId,
      task_id: nextTask.id,
      actor: "executor",
      status: "ok",
      side_effect: nextTask.side_effect,
      message: nextTask.title,
    });

    const contextPack = await buildContextPack(paths, message, config);
    const executorPrompt = buildExecutorPrompt(message, nextTask, contextPack, config, paths);
    const executorRaw = await runner.callCodex(executorPrompt, { resume: false });
    const execution = validateExecutorOutput(parseJsonObject<ExecutorOutput>(executorRaw), nextTask.id);

    await appendRunLedgerEvent(paths, {
      event: "task.executed",
      run_id: runId,
      task_id: nextTask.id,
      actor: "executor",
      status: execution.status === "done" ? "ok" : execution.status === "blocked" ? "warning" : "error",
      side_effect: nextTask.side_effect,
      message: execution.result_summary,
      data: {
        artifacts: execution.artifacts,
        missing_dependency: execution.missing_dependency || null,
      },
    });

    if (execution.missing_dependency && execution.missing_dependency.name) {
      const installResult = await attemptUserSpaceInstall(paths, nextTask, execution.missing_dependency);
      await appendRunLedgerEvent(paths, {
        event: "dependency.install",
        run_id: runId,
        task_id: nextTask.id,
        actor: "governor",
        status:
          installResult.status === "installed"
            ? "ok"
            : installResult.status === "escalated"
              ? "warning"
              : "error",
        side_effect: "write_local",
        message: installResult.details,
      });

      if (installResult.status === "installed") {
        nextTask.retries += 1;
        nextTask.status = "pending";
        nextTask.critic_issues = [];
        await saveTaskGraph(paths, graph);
        continue;
      }

      if (installResult.status === "escalated") {
        nextTask.status = "blocked";
        nextTask.critic_issues = [installResult.details];
        await saveTaskGraph(paths, graph);
        continue;
      }
    }

    graph.status = "criticizing";
    await saveTaskGraph(paths, graph);
    const criticPrompt = buildCriticPrompt(message, nextTask, execution, contextPack);
    const criticRaw = await runner.callCodex(criticPrompt, { resume: false });
    const critic = validateCriticOutput(parseJsonObject<CriticOutput>(criticRaw), nextTask.id);

    await appendRunLedgerEvent(paths, {
      event: "task.criticized",
      run_id: runId,
      task_id: nextTask.id,
      actor: "critic",
      status: critic.verdict === "pass" ? "ok" : critic.verdict === "block" ? "error" : "warning",
      side_effect: "read",
      message: critic.verdict,
      data: {
        issues: critic.issues,
        suggested_fix: critic.suggested_fix,
      },
    });

    if (critic.verdict === "pass" && execution.status === "done") {
      nextTask.status = "done";
      nextTask.result_summary = execution.result_summary;
      nextTask.critic_issues = [];
      await saveTaskGraph(paths, graph);
      continue;
    }

    if (critic.verdict === "retry") {
      nextTask.critic_issues = critic.issues;
      if (nextTask.retries < config.retry_budget_per_node) {
        nextTask.retries += 1;
        nextTask.status = "pending";
      } else {
        nextTask.status = "failed";
      }
      await saveTaskGraph(paths, graph);
      continue;
    }

    if (critic.verdict === "replan") {
      if (replanCount < config.replan_budget_per_run) {
        replanCount += 1;
        graph.status = "replanning";
        await saveTaskGraph(paths, graph);
        const replanContext = await buildContextPack(paths, message, config);
        const replanPrompt = buildPlannerPrompt(
          `${message}\nReplan reason for ${nextTask.id}: ${critic.issues.join("; ")}`,
          replanContext,
          config
        );
        const replanRaw = await runner.callCodex(replanPrompt, { resume: false });
        const replanned = validatePlannerOutput(
          parseJsonObject<PlannerOutput>(replanRaw),
          message,
          config
        );
        graph.nodes = mergeReplanIntoGraph(graph, replanned);
        graph.summary = replanned.summary;
        nextTask.status = "failed";
        await appendRunLedgerEvent(paths, {
          event: "plan.replanned",
          run_id: runId,
          task_id: nextTask.id,
          actor: "planner",
          status: "warning",
          side_effect: "read",
          message: critic.suggested_fix || "Replanned after critic request.",
          data: { task_count: graph.nodes.length },
        });
        await saveTaskGraph(paths, graph);
        continue;
      }

      nextTask.status = "blocked";
      nextTask.critic_issues = critic.issues.length > 0 ? critic.issues : ["Replan budget exhausted."];
      await saveTaskGraph(paths, graph);
      continue;
    }

    nextTask.status = "blocked";
    nextTask.critic_issues = critic.issues;
    await saveTaskGraph(paths, graph);
  }

  if (graph.status !== "done" && graph.status !== "blocked") {
    graph.status = "blocked";
    graph.current_task_id = null;
    await saveTaskGraph(paths, graph);
    await appendRunLedgerEvent(paths, {
      event: "run.iteration_budget_exhausted",
      run_id: runId,
      actor: "governor",
      status: "warning",
      message: "Iteration budget exhausted before terminal state.",
    });
  }

  await appendRunLedgerEvent(paths, {
    event: "run.finished",
    run_id: runId,
    actor: "governor",
    status: graph.status === "done" ? "ok" : "warning",
    message: `Run finished with status=${graph.status}`,
  });

  return {
    response: summarizeGraph(graph),
    graph,
  };
}

interface ProcedureScore {
  title: string;
  score: number;
  success_count: number;
  has_validation: boolean;
}

function parseProcedureScores(markdown: string): ProcedureScore[] {
  const sections = markdown.split(/^##\s+/m).slice(1);
  return sections.map((section) => {
    const lines = section.split("\n");
    const title = (lines[0] || "Unnamed Procedure").trim();
    const successLine = lines.find((line) => /success count:/i.test(line)) || "";
    const successMatch = successLine.match(/(\d+)/);
    const successCount = successMatch ? parseInt(successMatch[1], 10) : 0;
    const hasValidation = lines.some((line) => /last validated:/i.test(line));
    const score = successCount * 2 + (hasValidation ? 1 : 0);
    return {
      title,
      score,
      success_count: successCount,
      has_validation: hasValidation,
    };
  });
}

function isDatedMemoryFile(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.md$/.test(name);
}

async function archiveOldMemory(paths: WorkspacePaths, retentionDays: number): Promise<number> {
  const archiveDir = join(paths.memoryDir, "archive");
  await mkdir(archiveDir, { recursive: true });

  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  let archived = 0;

  const files = await readdir(paths.memoryDir).catch(() => []);
  for (const fileName of files) {
    if (!isDatedMemoryFile(fileName)) continue;
    const source = join(paths.memoryDir, fileName);
    const fileStat = await stat(source).catch(() => null);
    if (!fileStat) continue;
    if (now - fileStat.mtimeMs <= maxAgeMs) continue;
    await rename(source, join(archiveDir, fileName)).catch(() => {});
    archived += 1;
  }

  return archived;
}

export async function runMaintenanceCycle(paths: WorkspacePaths): Promise<void> {
  const retentionDays = Math.max(
    7,
    parseInt(process.env.AUTONOMOUS_MEMORY_RETENTION_DAYS || "30", 10) || 30
  );

  const archived = await archiveOldMemory(paths, retentionDays);
  const proceduresMarkdown = await readFile(paths.proceduresFile, "utf-8").catch(() => "");
  const procedureScores = parseProcedureScores(proceduresMarkdown);
  const scoresFile = join(paths.brainDir, "PROCEDURE_SCORES.json");
  await writeFile(scoresFile, `${JSON.stringify(procedureScores, null, 2)}\n`, "utf-8");

  await appendRunLedgerEvent(paths, {
    event: "maintenance.completed",
    actor: "system",
    status: "ok",
    side_effect: "write_local",
    message: "Maintenance cycle completed.",
    data: {
      archived_memory_files: archived,
      procedure_scores_file: scoresFile,
      procedures_scored: procedureScores.length,
    },
  });
}

export function shouldEnableMaintenanceLoop(): boolean {
  return (process.env.AUTONOMOUS_MAINTENANCE_LOOP || "false").toLowerCase() === "true";
}
