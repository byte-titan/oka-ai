import { appendFile, copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { delimiter, dirname, isAbsolute, join } from "path";
import { fileURLToPath } from "url";

export type SideEffectClass = "read" | "write_local" | "external_mutation";

export interface WorkspacePaths {
  workspaceDir: string;
  agentsFile: string;
  heartbeatFile: string;
  legacyPromptFile: string;
  sessionFile: string;
  checkinStateFile: string;
  tempDir: string;
  uploadsDir: string;
  memoryDir: string;
  brainDir: string;
  toolsDir: string;
  toolsBinDir: string;
  toolsPythonDir: string;
  toolsNodeDir: string;
  runLedgerFile: string;
  activeTaskGraphFile: string;
  backgroundTasksFile: string;
  autonomousConfigFile: string;
  installRequirementsFile: string;
  todosFile: string;
  learningsFile: string;
  proceduresFile: string;
}

interface WorkspaceTemplateFile {
  source: string;
  destination: string;
}

interface WorkspaceBootstrapOptions {
  logPrefix?: string;
}

export interface WorkspaceBootstrapResult {
  createdFiles: string[];
  copiedFiles: string[];
}

export interface RunLedgerEvent {
  event: string;
  run_id?: string;
  task_id?: string;
  actor?: "planner" | "executor" | "critic" | "governor" | "system";
  status?: "ok" | "warning" | "error";
  side_effect?: SideEffectClass;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ActiveTaskNodeState {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked" | "failed";
  depends_on: string[];
  acceptance_criteria: string[];
  retries: number;
  risk: "low" | "medium" | "high";
  side_effect: SideEffectClass;
  result_summary?: string;
  critic_issues?: string[];
}

export interface ActiveTaskGraphState {
  version: "v3";
  run_id: string | null;
  goal: string;
  status: "planning" | "executing" | "criticizing" | "replanning" | "blocked" | "done";
  summary: string;
  nodes: ActiveTaskNodeState[];
  current_task_id: string | null;
  updated_at: string;
  created_at: string;
}

export interface AutonomousRuntimeConfig {
  version: "3";
  max_tasks_per_plan: number;
  retry_budget_per_node: number;
  replan_budget_per_run: number;
  context_pack: {
    max_relevant_facts: number;
    max_related_episodes: number;
    max_procedures: number;
  };
  policy: {
    allow_external_mutation: boolean;
  };
}

const DEFAULT_AUTONOMOUS_CONFIG: AutonomousRuntimeConfig = {
  version: "3",
  max_tasks_per_plan: 5,
  retry_budget_per_node: 1,
  replan_budget_per_run: 1,
  context_pack: {
    max_relevant_facts: 6,
    max_related_episodes: 8,
    max_procedures: 3,
  },
  policy: {
    allow_external_mutation: false,
  },
};

const DEFAULT_ACTIVE_TASK_GRAPH: Omit<ActiveTaskGraphState, "created_at" | "updated_at"> = {
  version: "v3",
  run_id: null,
  goal: "",
  status: "done",
  summary: "",
  nodes: [],
  current_task_id: null,
};

const WORKSPACE_TEMPLATE_DIR = fileURLToPath(
  new URL("../defaults/workspace", import.meta.url)
);

function resolvePathFromEnv(
  pathValue: string,
  options: {
    workspaceDir: string;
    cwd: string;
    preferWorkspaceForBareNames?: boolean;
  }
): string {
  if (isAbsolute(pathValue)) return pathValue;
  if (pathValue.startsWith("~/")) {
    const home = process.env.HOME || "";
    return join(home, pathValue.slice(2));
  }

  const isExplicitRelative =
    pathValue.startsWith("./") || pathValue.startsWith("../") || pathValue.includes("/");
  if (isExplicitRelative) {
    return join(options.cwd, pathValue);
  }

  if (options.preferWorkspaceForBareNames) {
    return join(options.workspaceDir, pathValue);
  }

  return join(options.cwd, pathValue);
}

export function resolveWorkspacePaths(env = process.env, cwd = process.cwd()): WorkspacePaths {
  const workspaceDir = resolvePathFromEnv(env.OKA_WORKSPACE_DIR || env.RELAY_DIR || "~/.oka", {
    cwd,
    workspaceDir: cwd,
  });

  const agentsFile = resolvePathFromEnv(
    env.AGENTS_FILE || env.PROMPT_FILE || "AGENTS.md",
    {
      cwd,
      workspaceDir,
      preferWorkspaceForBareNames: true,
    }
  );

  const heartbeatFile = resolvePathFromEnv(env.HEARTBEAT_FILE || "HEARTBEAT.md", {
    cwd,
    workspaceDir,
    preferWorkspaceForBareNames: true,
  });

  return {
    workspaceDir,
    agentsFile,
    heartbeatFile,
    legacyPromptFile: join(workspaceDir, "prompt.md"),
    sessionFile: join(workspaceDir, "session.json"),
    checkinStateFile: join(workspaceDir, "checkin-state.json"),
    tempDir: join(workspaceDir, "temp"),
    uploadsDir: join(workspaceDir, "uploads"),
    memoryDir: join(workspaceDir, "memory"),
    brainDir: join(workspaceDir, "brain"),
    toolsDir: join(workspaceDir, "tools"),
    toolsBinDir: join(workspaceDir, "tools", "bin"),
    toolsPythonDir: join(workspaceDir, "tools", "python"),
    toolsNodeDir: join(workspaceDir, "tools", "node"),
    runLedgerFile: join(workspaceDir, "run_ledger.jsonl"),
    activeTaskGraphFile: join(workspaceDir, "active_task_graph.json"),
    backgroundTasksFile: join(workspaceDir, "background_tasks.json"),
    autonomousConfigFile: join(workspaceDir, "autonomous.config.json"),
    installRequirementsFile: join(workspaceDir, "INSTALL_REQUIREMENTS.md"),
    todosFile: join(workspaceDir, "brain", "TODOS.md"),
    learningsFile: join(workspaceDir, "brain", "LEARNINGS.md"),
    proceduresFile: join(workspaceDir, "brain", "PROCEDURES.md"),
  };
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await readFile(pathValue, "utf-8");
    return true;
  } catch {
    return false;
  }
}

async function ensureFile(pathValue: string, content: string): Promise<boolean> {
  if (await fileExists(pathValue)) {
    return false;
  }
  await mkdir(dirname(pathValue), { recursive: true });
  await writeFile(pathValue, content, "utf-8");
  return true;
}

async function ensureCopiedFile({
  source,
  destination,
}: WorkspaceTemplateFile): Promise<boolean> {
  if (await fileExists(destination)) {
    return false;
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return true;
}

export async function ensureWorkspaceBootstrap(
  paths: WorkspacePaths,
  options: WorkspaceBootstrapOptions = {}
): Promise<WorkspaceBootstrapResult> {
  const createdFiles: string[] = [];
  const copiedFiles: string[] = [];
  const logPrefix = options.logPrefix ? `${options.logPrefix} ` : "";

  await mkdir(paths.workspaceDir, { recursive: true });
  await mkdir(paths.tempDir, { recursive: true });
  await mkdir(paths.uploadsDir, { recursive: true });
  await mkdir(paths.memoryDir, { recursive: true });
  await mkdir(paths.brainDir, { recursive: true });
  await mkdir(paths.toolsBinDir, { recursive: true });
  await mkdir(paths.toolsPythonDir, { recursive: true });
  await mkdir(paths.toolsNodeDir, { recursive: true });

  // One-time migration from legacy prompt.md file.
  if (!(await fileExists(paths.agentsFile)) && (await fileExists(paths.legacyPromptFile))) {
    await mkdir(dirname(paths.agentsFile), { recursive: true });
    await copyFile(paths.legacyPromptFile, paths.agentsFile);
    copiedFiles.push(paths.agentsFile);
  }

  const templateFiles: WorkspaceTemplateFile[] = [
    { source: join(WORKSPACE_TEMPLATE_DIR, "AGENTS.md"), destination: paths.agentsFile },
    { source: join(WORKSPACE_TEMPLATE_DIR, "HEARTBEAT.md"), destination: paths.heartbeatFile },
    {
      source: join(WORKSPACE_TEMPLATE_DIR, "autonomous.config.json"),
      destination: paths.autonomousConfigFile,
    },
    { source: join(WORKSPACE_TEMPLATE_DIR, "brain", "TODOS.md"), destination: paths.todosFile },
    {
      source: join(WORKSPACE_TEMPLATE_DIR, "brain", "LEARNINGS.md"),
      destination: paths.learningsFile,
    },
    {
      source: join(WORKSPACE_TEMPLATE_DIR, "brain", "PROCEDURES.md"),
      destination: paths.proceduresFile,
    },
    {
      source: join(WORKSPACE_TEMPLATE_DIR, "INSTALL_REQUIREMENTS.md"),
      destination: paths.installRequirementsFile,
    },
  ];

  for (const template of templateFiles) {
    if (await ensureCopiedFile(template)) {
      copiedFiles.push(template.destination);
    }
  }

  const now = new Date().toISOString();
  const graphSeed: ActiveTaskGraphState = {
    ...DEFAULT_ACTIVE_TASK_GRAPH,
    created_at: now,
    updated_at: now,
  };

  if (
    await ensureFile(paths.activeTaskGraphFile, `${JSON.stringify(graphSeed, null, 2)}\n`)
  ) {
    createdFiles.push(paths.activeTaskGraphFile);
  }

  if (await ensureFile(paths.runLedgerFile, "")) {
    createdFiles.push(paths.runLedgerFile);
  }

  if (await ensureFile(paths.backgroundTasksFile, "[]\n")) {
    createdFiles.push(paths.backgroundTasksFile);
  }

  if (copiedFiles.length > 0 || createdFiles.length > 0) {
    console.log(
      `${logPrefix}Workspace bootstrap complete (copied=${copiedFiles.length}, created=${createdFiles.length})`
    );
  }

  return { createdFiles, copiedFiles };
}

export async function appendRunLedgerEvent(
  paths: WorkspacePaths,
  event: RunLedgerEvent
): Promise<void> {
  const payload = {
    ts: new Date().toISOString(),
    ...event,
  };
  await appendFile(paths.runLedgerFile, `${JSON.stringify(payload)}\n`, "utf-8");
}

export async function loadAutonomousConfig(
  paths: WorkspacePaths
): Promise<AutonomousRuntimeConfig> {
  try {
    const content = await readFile(paths.autonomousConfigFile, "utf-8");
    const parsed = JSON.parse(content) as Partial<AutonomousRuntimeConfig>;
    return {
      ...DEFAULT_AUTONOMOUS_CONFIG,
      ...parsed,
      context_pack: {
        ...DEFAULT_AUTONOMOUS_CONFIG.context_pack,
        ...(parsed.context_pack || {}),
      },
      policy: {
        ...DEFAULT_AUTONOMOUS_CONFIG.policy,
        ...(parsed.policy || {}),
      },
    };
  } catch {
    return DEFAULT_AUTONOMOUS_CONFIG;
  }
}

export function buildWorkspacePathEnv(paths: WorkspacePaths, basePath = process.env.PATH || ""): string {
  const pythonBin = join(paths.toolsPythonDir, "bin");
  const nodeBin = join(paths.toolsNodeDir, "bin");
  return [paths.toolsBinDir, pythonBin, nodeBin, basePath].filter(Boolean).join(delimiter);
}
