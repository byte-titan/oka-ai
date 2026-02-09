/**
 * Codex Telegram Relay
 *
 * Autonomous concept v3 runtime with workspace bootstrap.
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { spawn } from "bun";
import { unlinkSync } from "fs";
import { access, appendFile, readFile, unlink, writeFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { runAutonomousV3, runMaintenanceCycle, shouldEnableMaintenanceLoop } from "./autonomous-v3";
import {
  buildWorkspacePathEnv,
  ensureWorkspaceBootstrap,
  resolveWorkspacePaths,
} from "./workspace";
import { shouldEnableVoiceRelay, startVoiceRelay } from "./voice-relay";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CODEX_PATH = process.env.CODEX_PATH || process.env.CLAUDE_PATH || "codex";
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || "low";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const CODEX_FULL_ACCESS = (process.env.CODEX_FULL_ACCESS || "true").toLowerCase() === "true";
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || "danger-full-access";
const AUTONOMOUS_V3_ENABLED = (process.env.AUTONOMOUS_V3_ENABLED || "true").toLowerCase() !== "false";
const BACKGROUND_TASK_LOOP_MS = Math.max(
  1000,
  parseInt(process.env.BACKGROUND_TASK_LOOP_MS || "5000", 10) || 5000
);
const BACKGROUND_TASK_MAX_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.BACKGROUND_TASK_MAX_ATTEMPTS || "2", 10) || 2
);

const WORKSPACE_PATHS = resolveWorkspacePaths();
const WORKSPACE_DIR = WORKSPACE_PATHS.workspaceDir;
const AGENTS_FILE = WORKSPACE_PATHS.agentsFile;
const SESSION_FILE = WORKSPACE_PATHS.sessionFile;
const MEMORY_DIR = WORKSPACE_PATHS.memoryDir;
const TEMP_DIR = WORKSPACE_PATHS.tempDir;
const UPLOADS_DIR = WORKSPACE_PATHS.uploadsDir;

const WHISPER_CLI_PATH = resolveBinaryPath(
  process.env.WHISPER_CLI_PATH || join(process.cwd(), "tools/whisper.cpp/build/bin/whisper-cli")
);
const WHISPER_MODEL_PATH = resolveBinaryPath(
  process.env.WHISPER_MODEL_PATH || join(process.cwd(), "tools/whisper.cpp/models/ggml-base.bin")
);
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const WHISPER_LANG = process.env.WHISPER_LANG || "auto";
const WHISPER_THREADS = Math.max(1, parseInt(process.env.WHISPER_THREADS || "4", 10) || 4);
const WHISPER_KEEP_TEMP = (process.env.WHISPER_KEEP_TEMP || "false").toLowerCase() === "true";

const DEFAULT_AGENTS_TEMPLATE = [
  "You are operating in autonomous concept v3 mode.",
  "",
  "Time: {{CURRENT_TIME}}",
  "Timezone: {{TIMEZONE}}",
  "User message:",
  "{{USER_MESSAGE}}",
].join("\n");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

interface RouteDecision {
  route: "direct" | "background";
  reason: string;
}

interface BackgroundTask {
  id: string;
  status: "pending" | "running" | "done" | "failed";
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  request_text: string;
  chat_id: number | string;
  requester_user_id?: string;
  attempts: number;
  max_attempts: number;
  last_error?: string;
  route_reason: string;
}

const LOCK_FILE = join(WORKSPACE_DIR, "bot.lock");
let session: SessionState = { sessionId: null, lastActivity: new Date().toISOString() };
let promptLoadWarningShown = false;
let voiceRelayServer: Bun.Server | null = null;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let backgroundTaskTimer: ReturnType<typeof setInterval> | null = null;
let backgroundWorkerRunning = false;

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content) as SessionState;
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock, 10);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0);
          console.log(`Another instance running (PID: ${pid})`);
          return false;
        } catch {
          console.log("Stale lock found, taking over...");
        }
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

function setupSignalHandlers(): void {
  process.on("exit", () => {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      // Ignore cleanup failures.
    }
  });

  process.on("SIGINT", async () => {
    maintenanceTimer && clearInterval(maintenanceTimer);
    backgroundTaskTimer && clearInterval(backgroundTaskTimer);
    voiceRelayServer?.stop(true);
    await releaseLock();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    maintenanceTimer && clearInterval(maintenanceTimer);
    backgroundTaskTimer && clearInterval(backgroundTaskTimer);
    voiceRelayServer?.stop(true);
    await releaseLock();
    process.exit(0);
  });
}

// ============================================================
// CORE: Call Codex CLI
// ============================================================

async function callCodex(prompt: string, options?: { resume?: boolean }): Promise<string> {
  const args = buildCodexCommand(prompt, options);
  console.log(`Calling Codex: ${prompt.substring(0, 60)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: WORKSPACE_DIR,
      env: {
        ...process.env,
        PATH: buildWorkspacePathEnv(WORKSPACE_PATHS),
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Codex error:", stderr);
      return `Error: ${stderr || `Codex exited with code ${exitCode}`}`;
    }

    const parsed = parseCodexOutput(output);
    if (parsed.sessionId) {
      session.sessionId = parsed.sessionId;
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return parsed.response || "No response from Codex.";
  } catch (error) {
    console.error("Spawn error:", error);
    return "Error: Could not run Codex CLI";
  }
}

function buildCodexCommand(prompt: string, options?: { resume?: boolean }): string[] {
  const args = [CODEX_PATH];

  if (CODEX_FULL_ACCESS) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-s", CODEX_SANDBOX);
  }

  args.push("exec", "--json", "-c", `model_reasoning_effort=\"${CODEX_REASONING_EFFORT}\"`);

  if (CODEX_MODEL) {
    args.push("--model", CODEX_MODEL);
  }

  if (options?.resume && session.sessionId) {
    args.push("resume", session.sessionId, prompt);
  } else {
    args.push(prompt);
  }

  return args;
}

function parseCodexOutput(output: string): { response: string; sessionId: string | null } {
  const messages: string[] = [];
  let sessionId: string | null = null;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as CodexEvent;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
      }

      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        messages.push(event.item.text.trim());
      }
    } catch {
      messages.push(trimmed);
    }
  }

  return {
    response: messages.join("\n\n").trim(),
    sessionId,
  };
}

// ============================================================
// ASSISTANT FLOW
// ============================================================

function parseJsonObject<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    // Keep trying with extracted object bounds.
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

async function classifyRequestRouteWithLlm(userMessage: string): Promise<RouteDecision> {
  if (!AUTONOMOUS_V3_ENABLED) {
    return { route: "direct", reason: "Autonomous background mode is disabled." };
  }

  if (isSmallTalkMessage(userMessage)) {
    return { route: "direct", reason: "Small-talk shortcut." };
  }

  const prompt = [
    "Role: Request Router.",
    "Decide whether a user request should run directly now or go to background autonomous cycle.",
    "Return strict JSON only. No markdown.",
    "Schema:",
    '{ "route": "direct|background", "reason": "short string" }',
    "Routing rules:",
    "- Use direct for quick factual Q&A, time/date/weather, brief chat, simple clarifications.",
    "- Use background for multi-step tasks, coding/build/fix work, research with evidence, file changes, or scheduled/deferred actions.",
    "- If uncertain, prefer direct.",
    `User request: ${userMessage}`,
  ].join("\n");

  const raw = await callCodex(prompt, { resume: false });
  const parsed = parseJsonObject<Partial<RouteDecision>>(raw);

  if (parsed?.route === "background") {
    return {
      route: "background",
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "LLM chose background.",
    };
  }

  if (parsed?.route === "direct") {
    return {
      route: "direct",
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "LLM chose direct.",
    };
  }

  // Fallback rule when classification output is invalid.
  const normalized = userMessage.trim().toLowerCase();
  if (/(in\s+\d+\s+(minute|minutes|hour|hours)|\b(at|tomorrow|later|schedule|remind)\b)/i.test(normalized)) {
    return { route: "background", reason: "Fallback: deferred/scheduling language detected." };
  }

  return { route: "direct", reason: "Fallback: invalid classifier output." };
}

async function generateDirectAssistantResponse(userMessage: string): Promise<string> {
  const policyPrompt = await buildPolicyPrompt(userMessage);
  const enrichedPrompt = await buildPromptWithMemory(userMessage, policyPrompt);
  return callCodex(enrichedPrompt, { resume: true });
}

// ============================================================
// MEMORY + PROMPT HELPERS
// ============================================================

async function loadPromptTemplate(): Promise<string> {
  try {
    return await readFile(AGENTS_FILE, "utf-8");
  } catch (error) {
    if (!promptLoadWarningShown) {
      console.warn(`Could not read AGENTS file at ${AGENTS_FILE}. Using built-in template.`, error);
      promptLoadWarningShown = true;
    }
    return DEFAULT_AGENTS_TEMPLATE;
  }
}

async function buildPolicyPrompt(userMessage: string): Promise<string> {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeStr = now.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const template = await loadPromptTemplate();
  return template
    .replaceAll("{{CURRENT_TIME}}", timeStr)
    .replaceAll("{{TIMEZONE}}", timezone)
    .replaceAll("{{USER_MESSAGE}}", userMessage)
    .trim();
}

async function buildPromptWithMemory(userMessage: string, policyPrompt?: string): Promise<string> {
  const policy = policyPrompt || (await buildPolicyPrompt(userMessage));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const memoryContext = await loadRecentMemoryContext(timezone);

  if (!memoryContext) {
    return policy;
  }

  return `${policy}\n\nRecent memory context:\n${memoryContext}`;
}

function isSmallTalkMessage(userMessage: string): boolean {
  const normalized = userMessage.trim().toLowerCase();
  if (!normalized) return true;

  if (
    /^(hi|hello|hey|yo|sup|hola|good morning|good afternoon|good evening|thanks|thank you)[!. ]*$/i.test(
      normalized
    )
  ) {
    return true;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  const hasActionSignals = /(fix|build|implement|create|update|edit|run|check|debug|review|write|add|remove|delete)/i.test(
    normalized
  );
  const hasQuestion = normalized.includes("?");

  return words.length <= 3 && !hasActionSignals && !hasQuestion;
}

function wantsInternalExecutionDetails(userMessage: string): boolean {
  const normalized = userMessage.trim().toLowerCase();
  if (!normalized) return false;
  return /(\b(show|give|include|share|explain)\b.*\b(details?|steps?|process|internal|under the hood|how)\b)|(\bhow did you\b)|(\bwhat did you do\b)|(\btask graph\b)|(\brun ledger\b)|(\bdebug\b)/i.test(
    normalized
  );
}

function cleanUserFacingText(text: string): string {
  return text
    .replace(/^completed:\s*/i, "")
    .replace(/^blocked:\s*/i, "")
    .replace(/^\s*-\s+/gm, "")
    .trim();
}

function formatAutonomousResultForUser(
  result: Awaited<ReturnType<typeof runAutonomousV3>>
): string {
  const doneNodes = result.graph.nodes.filter(
    (node) => node.status === "done" && typeof node.result_summary === "string" && node.result_summary.trim()
  );
  const blockedNode =
    result.graph.nodes.find((node) => node.status === "blocked") ||
    result.graph.nodes.find((node) => node.status === "failed");

  if (result.graph.status === "done" && doneNodes.length > 0) {
    const preferred =
      doneNodes.find((node) =>
        /(summary|answer|response|final|report|result|forecast)/i.test(node.title)
      ) || doneNodes[doneNodes.length - 1];
    const summary = cleanUserFacingText(preferred.result_summary || "");
    if (summary) return summary;
  }

  if (blockedNode) {
    const issue = cleanUserFacingText(
      blockedNode.critic_issues?.[0] || blockedNode.result_summary || "I hit a blocker while completing that."
    );
    return `I couldn't complete that fully: ${issue}`;
  }

  const fallback = cleanUserFacingText(result.response);
  if (fallback) return fallback;
  return "I couldn't produce a final answer for that yet.";
}

async function loadBackgroundTasks(): Promise<BackgroundTask[]> {
  try {
    const content = await readFile(WORKSPACE_PATHS.backgroundTasksFile, "utf-8");
    const parsed = JSON.parse(content) as BackgroundTask[];
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall back to empty queue.
  }
  return [];
}

async function saveBackgroundTasks(tasks: BackgroundTask[]): Promise<void> {
  await writeFile(WORKSPACE_PATHS.backgroundTasksFile, `${JSON.stringify(tasks, null, 2)}\n`, "utf-8");
}

function buildBackgroundTaskId(): string {
  return `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function enqueueBackgroundTask(input: {
  requestText: string;
  chatId: number | string;
  requesterUserId?: string;
  routeReason: string;
}): Promise<BackgroundTask> {
  const now = new Date().toISOString();
  const task: BackgroundTask = {
    id: buildBackgroundTaskId(),
    status: "pending",
    created_at: now,
    updated_at: now,
    request_text: input.requestText,
    chat_id: input.chatId,
    requester_user_id: input.requesterUserId,
    attempts: 0,
    max_attempts: BACKGROUND_TASK_MAX_ATTEMPTS,
    route_reason: input.routeReason,
  };

  const queue = await loadBackgroundTasks();
  queue.push(task);
  await saveBackgroundTasks(queue);
  return task;
}

async function updateBackgroundTask(
  taskId: string,
  update: (task: BackgroundTask) => BackgroundTask
): Promise<BackgroundTask | null> {
  const queue = await loadBackgroundTasks();
  const index = queue.findIndex((task) => task.id === taskId);
  if (index === -1) return null;
  const next = update(queue[index]);
  queue[index] = next;
  await saveBackgroundTasks(queue);
  return next;
}

async function claimNextBackgroundTask(): Promise<BackgroundTask | null> {
  const queue = await loadBackgroundTasks();
  const next = queue.find(
    (task) =>
      (task.status === "pending" || task.status === "failed") &&
      task.attempts < Math.max(1, task.max_attempts)
  );
  if (!next) return null;

  const now = new Date().toISOString();
  next.status = "running";
  next.updated_at = now;
  next.started_at = now;
  next.attempts += 1;
  await saveBackgroundTasks(queue);
  return next;
}

function getDateStamp(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === "year")?.value || "1970";
  const month = parts.find((p) => p.type === "month")?.value || "01";
  const day = parts.find((p) => p.type === "day")?.value || "01";

  return `${year}-${month}-${day}`;
}

function getTimeStamp(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

async function appendMemoryEntry(role: "user" | "assistant", text: string): Promise<void> {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dateStamp = getDateStamp(timezone);
    const timeStamp = getTimeStamp(timezone);
    const filePath = join(MEMORY_DIR, `${dateStamp}.md`);
    const safeText = text.trim();
    if (!safeText) return;
    const line = `- ${timeStamp} [${role}] ${safeText.replaceAll("\n", "\n  ")}\n`;
    await appendFile(filePath, line, "utf-8");
  } catch (error) {
    console.warn("Could not append memory entry:", error);
  }
}

async function loadRecentMemoryContext(timezone: string): Promise<string> {
  const today = getDateStamp(timezone);
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);

  const yesterday = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(yesterdayDate)
    .reduce(
      (acc, part) => {
        if (part.type === "year") acc.year = part.value;
        if (part.type === "month") acc.month = part.value;
        if (part.type === "day") acc.day = part.value;
        return acc;
      },
      { year: "1970", month: "01", day: "01" }
    );

  const yesterdayStamp = `${yesterday.year}-${yesterday.month}-${yesterday.day}`;
  const files = [join(MEMORY_DIR, `${yesterdayStamp}.md`), join(MEMORY_DIR, `${today}.md`)];
  const sections: string[] = [];

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      const tail = lines.slice(-25).join("\n");
      if (tail) sections.push(`# ${filePath}\n${tail}`);
    } catch {
      // Missing files are normal.
    }
  }

  return sections.join("\n\n").trim();
}

// ============================================================
// MEDIA HELPERS
// ============================================================

async function transcribeWithLocalWhisper(audioPath: string): Promise<string> {
  const outputBase = join(UPLOADS_DIR, `whisper_${Date.now()}`);
  const outputCandidates = [`${outputBase}.txt`, `${audioPath}.txt`, `${audioPath}.ogg.txt`];

  try {
    const proc = spawn(
      [
        WHISPER_CLI_PATH,
        "-m",
        WHISPER_MODEL_PATH,
        "-f",
        audioPath,
        "-l",
        WHISPER_LANG,
        "-t",
        String(WHISPER_THREADS),
        "-otxt",
        "-of",
        outputBase,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(stderr || stdout || `whisper-cli exited with code ${exitCode}`);
    }

    for (const outputTxt of outputCandidates) {
      try {
        await access(outputTxt);
        const text = await readFile(outputTxt, "utf-8");
        const trimmed = text.trim();
        if (trimmed) return trimmed;
      } catch {
        // Check next candidate.
      }
    }

    const stdoutTranscript = extractTranscriptFromWhisperStdout(stdout, stderr);
    if (stdoutTranscript) return stdoutTranscript;

    throw new Error(
      `Whisper completed but no transcript was produced. stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`
    );
  } finally {
    for (const outputTxt of outputCandidates) {
      if (!WHISPER_KEEP_TEMP) {
        await unlink(outputTxt).catch(() => {});
      }
    }
  }
}

async function prepareAudioForWhisper(sourcePath: string): Promise<string> {
  // Telegram voice notes are usually OGG/Opus. Convert to WAV for reliable decoding.
  if (!sourcePath.toLowerCase().endsWith(".ogg")) {
    return sourcePath;
  }

  const wavPath = sourcePath.replace(/\.ogg$/i, ".wav");
  try {
    const proc = spawn([FFMPEG_PATH, "-y", "-i", sourcePath, "-ar", "16000", "-ac", "1", wavPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.warn("ffmpeg convert failed, falling back to original audio:", stderr);
      return sourcePath;
    }
    return wavPath;
  } catch (error) {
    console.warn("ffmpeg unavailable, falling back to original audio:", error);
    return sourcePath;
  }
}

function extractTranscriptFromWhisperStdout(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      return !(
        line.startsWith("whisper_") ||
        line.startsWith("system_info:") ||
        line.startsWith("main:") ||
        line.startsWith("output_txt:") ||
        line.startsWith("output_vtt:") ||
        line.startsWith("output_srt:") ||
        line.startsWith("whisper_print_timings:")
      );
    });

  if (lines.length === 0) return "";

  return lines
    .map((line) => line.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, ""))
    .join("\n")
    .trim();
}

// ============================================================
// TELEGRAM MESSAGE HANDLERS
// ============================================================

async function sendResponse(ctx: Context, response: string): Promise<void> {
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await sendTelegramFormattedMessage(ctx, response);
    return;
  }

  const chunks: string[] = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await sendTelegramFormattedMessage(ctx, chunk);
  }
}

function escapeMarkdownV2Text(input: string): string {
  return input.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function escapeMarkdownV2Code(input: string): string {
  return input.replace(/([`\\])/g, "\\$1");
}

function escapeMarkdownV2Link(input: string): string {
  return input.replace(/([)\\])/g, "\\$1");
}

function transformInlineMarkdownToTelegram(input: string): string {
  const placeholders: string[] = [];
  const put = (value: string): string => {
    const token = `@@TGMDBLOCK${placeholders.length}@@`;
    placeholders.push(value);
    return token;
  };

  let working = input;

  // Inline code
  working = working.replace(/`([^`\n]+)`/g, (_match, code) => {
    return put(`\`${escapeMarkdownV2Code(code)}\``);
  });

  // Links [text](url)
  working = working.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    return put(`[${escapeMarkdownV2Text(label)}](${escapeMarkdownV2Link(url)})`);
  });

  // Bold **text**
  working = working.replace(/\*\*([^*\n]+)\*\*/g, (_match, value) => {
    return put(`*${escapeMarkdownV2Text(value)}*`);
  });

  // Italic *text*
  working = working.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, (_match, prefix, value) => {
    return `${prefix}${put(`_${escapeMarkdownV2Text(value)}_`)}`;
  });

  // Escape rest
  working = escapeMarkdownV2Text(working);

  // Restore placeholders
  return working.replace(/@@TGMDBLOCK(\d+)@@/g, (_match, i) => placeholders[Number(i)] || "");
}

function formatMarkdownForTelegram(input: string): string {
  const normalized = input.replace(/\r\n/g, "\n");
  const codePlaceholders: string[] = [];
  const putCode = (value: string): string => {
    const token = `@@TGCODEBLOCK${codePlaceholders.length}@@`;
    codePlaceholders.push(value);
    return token;
  };

  // Preserve fenced code blocks first
  let working = normalized.replace(/```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const safeLang = (lang || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const safeCode = escapeMarkdownV2Code(String(code).replace(/\n+$/g, ""));
    const block = safeLang ? `\`\`\`${safeLang}\n${safeCode}\n\`\`\`` : `\`\`\`\n${safeCode}\n\`\`\``;
    return putCode(block);
  });

  const lines = working.split("\n").map((line) => {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      return `*${escapeMarkdownV2Text(heading[1].trim())}*`;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      return `• ${transformInlineMarkdownToTelegram(unordered[1].trim())}`;
    }

    const ordered = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (ordered) {
      return `${ordered[1]}\\. ${transformInlineMarkdownToTelegram(ordered[2].trim())}`;
    }

    if (!line.trim()) return "";
    return transformInlineMarkdownToTelegram(line);
  });

  working = lines.join("\n");
  return working.replace(/@@TGCODEBLOCK(\d+)@@/g, (_match, i) => codePlaceholders[Number(i)] || "");
}

async function sendTelegramFormattedTextToChat(
  api: Context["api"],
  chatId: number | string,
  text: string
): Promise<void> {
  const formatted = formatMarkdownForTelegram(text);
  try {
    await api.sendMessage(chatId, formatted, {
      parse_mode: "MarkdownV2",
      link_preview_options: {
        is_disabled: true,
      },
    });
  } catch (error) {
    console.warn("MarkdownV2 formatting failed, sending plain text fallback:", error);
    await api.sendMessage(chatId, text, {
      link_preview_options: {
        is_disabled: true,
      },
    });
  }
}

async function sendTelegramFormattedMessage(ctx: Context, text: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply(text);
    return;
  }
  await sendTelegramFormattedTextToChat(ctx.api, chatId, text);
}

async function runWithTypingIndicator<T>(ctx: Context, task: () => Promise<T>): Promise<T> {
  await ctx.replyWithChatAction("typing");
  const pulse = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4500);

  try {
    return await task();
  } finally {
    clearInterval(pulse);
  }
}

function buildBackgroundQueuedAck(task: BackgroundTask): string {
  return [
    "Queued.",
    "I will run this in the background and send the result here.",
    `Task ID: ${task.id}`,
  ].join("\n");
}

function buildBackgroundCompletionMessage(task: BackgroundTask, resultText: string): string {
  const summary = resultText.trim() || "Completed.";
  return [
    `Background task complete (${task.id}):`,
    "",
    summary,
  ].join("\n");
}

function buildBackgroundFailureMessage(task: BackgroundTask, errorText: string): string {
  return [
    `Background task failed (${task.id}).`,
    "",
    errorText.trim() || "Unknown failure.",
  ].join("\n");
}

async function processNextBackgroundTask(api: Context["api"]): Promise<void> {
  if (backgroundWorkerRunning) return;
  backgroundWorkerRunning = true;

  try {
    const task = await claimNextBackgroundTask();
    if (!task) return;

    try {
      const result = await runAutonomousV3(task.request_text, WORKSPACE_PATHS, {
        callCodex,
      });
      const output = formatAutonomousResultForUser(result);
      const completionMessage = buildBackgroundCompletionMessage(task, output);
      await sendTelegramFormattedTextToChat(api, task.chat_id, completionMessage);
      await appendMemoryEntry("assistant", `[Background ${task.id}] ${output}`);

      await updateBackgroundTask(task.id, (current) => ({
        ...current,
        status: "done",
        updated_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        last_error: undefined,
      }));
    } catch (error) {
      const message = String(error);
      const willRetry = task.attempts < task.max_attempts;

      await updateBackgroundTask(task.id, (current) => ({
        ...current,
        status: willRetry ? "failed" : "failed",
        updated_at: new Date().toISOString(),
        finished_at: willRetry ? undefined : new Date().toISOString(),
        last_error: message,
      }));

      if (!willRetry) {
        await sendTelegramFormattedTextToChat(
          api,
          task.chat_id,
          buildBackgroundFailureMessage(task, message)
        );
      }
    }
  } finally {
    backgroundWorkerRunning = false;
  }
}

function startBackgroundTaskLoop(api: Context["api"]): void {
  console.log(`Background task loop: enabled (every ${BACKGROUND_TASK_LOOP_MS}ms)`);
  processNextBackgroundTask(api).catch((error) => {
    console.error("Background task iteration failed:", error);
  });

  backgroundTaskTimer = setInterval(() => {
    processNextBackgroundTask(api).catch((error) => {
      console.error("Background task iteration failed:", error);
    });
  }, BACKGROUND_TASK_LOOP_MS);
}

async function handleUserMessage(
  ctx: Context,
  userText: string,
  memoryLabel = userText,
  options?: { typingManagedExternally?: boolean }
): Promise<void> {
  const run = async () => {
    const routeDecision = await classifyRequestRouteWithLlm(userText);
    const chatId = ctx.chat?.id;

    await appendMemoryEntry("user", memoryLabel);

    if (routeDecision.route === "background" && chatId) {
      const task = await enqueueBackgroundTask({
        requestText: userText,
        chatId,
        requesterUserId: ctx.from?.id?.toString(),
        routeReason: routeDecision.reason,
      });
      const ack = buildBackgroundQueuedAck(task);
      await appendMemoryEntry("assistant", ack);
      await sendTelegramFormattedMessage(ctx, ack);
      return;
    }

    const response = await generateDirectAssistantResponse(userText);
    await appendMemoryEntry("assistant", response);
    await sendResponse(ctx, response);
  };

  if (options?.typingManagedExternally) {
    await run();
    return;
  }

  await runWithTypingIndicator(ctx, run);
}

function registerBotHandlers(bot: Bot): void {
  // SECURITY: Only respond to authorized user.
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id.toString();
    if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
      console.log(`Unauthorized: ${userId}`);
      await ctx.reply("This bot is private.");
      return;
    }
    await next();
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    console.log(`Message: ${text.substring(0, 60)}...`);
    await handleUserMessage(ctx, text);
  });

  bot.on("message:voice", async (ctx) => {
    console.log("Voice message received");

    let filePath = "";
    let transcriptionPath = "";

    try {
      await runWithTypingIndicator(ctx, async () => {
        const voice = ctx.message.voice;
        const file = await ctx.api.getFile(voice.file_id);
        const timestamp = Date.now();
        filePath = join(UPLOADS_DIR, `voice_${timestamp}.ogg`);

        const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
        const buffer = await response.arrayBuffer();
        await writeFile(filePath, Buffer.from(buffer));

        transcriptionPath = await prepareAudioForWhisper(filePath);
        const transcription = await transcribeWithLocalWhisper(transcriptionPath);
        if (!transcription) {
          await ctx.reply("I could not transcribe that voice message.");
          return;
        }

        await handleUserMessage(
          ctx,
          `[Voice transcription]\n${transcription}`,
          `[Voice] ${transcription}`,
          { typingManagedExternally: true }
        );
      });
    } catch (error) {
      console.error("Voice error:", error);
      await ctx.reply("Voice transcription failed. Check WHISPER_CLI_PATH and WHISPER_MODEL_PATH.");
    } finally {
      if (!WHISPER_KEEP_TEMP) {
        if (transcriptionPath && transcriptionPath !== filePath) {
          await unlink(transcriptionPath).catch(() => {});
        }
        if (filePath) {
          await unlink(filePath).catch(() => {});
        }
      }
    }
  });

  bot.on("message:photo", async (ctx) => {
    console.log("Image received");

    let filePath = "";
    try {
      await runWithTypingIndicator(ctx, async () => {
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];
        const file = await ctx.api.getFile(photo.file_id);
        const timestamp = Date.now();
        filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

        const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
        const buffer = await response.arrayBuffer();
        await writeFile(filePath, Buffer.from(buffer));

        const caption = ctx.message.caption || "Analyze this image.";
        await handleUserMessage(
          ctx,
          `[Image: ${filePath}]\n\n${caption}`,
          `[Image] ${caption}`,
          { typingManagedExternally: true }
        );
      });
    } catch (error) {
      console.error("Image error:", error);
      await ctx.reply("Could not process image.");
    } finally {
      if (filePath) {
        await unlink(filePath).catch(() => {});
      }
    }
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    console.log(`Document: ${doc.file_name}`);

    let filePath = "";
    try {
      await runWithTypingIndicator(ctx, async () => {
        const file = await ctx.getFile();
        const timestamp = Date.now();
        const fileName = doc.file_name || `file_${timestamp}`;
        filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

        const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
        const buffer = await response.arrayBuffer();
        await writeFile(filePath, Buffer.from(buffer));

        const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
        await handleUserMessage(
          ctx,
          `[File: ${filePath}]\n\n${caption}`,
          `[File] ${caption}`,
          { typingManagedExternally: true }
        );
      });
    } catch (error) {
      console.error("Document error:", error);
      await ctx.reply("Could not process document.");
    } finally {
      if (filePath) {
        await unlink(filePath).catch(() => {});
      }
    }
  });
}

function resolveBinaryPath(pathValue: string): string {
  if (isAbsolute(pathValue)) return pathValue;
  if (pathValue.startsWith("~/")) {
    const home = process.env.HOME || "";
    return join(home, pathValue.slice(2));
  }
  return join(process.cwd(), pathValue);
}

function startMaintenanceLoop(): void {
  if (!shouldEnableMaintenanceLoop()) {
    console.log("Maintenance loop: disabled (set AUTONOMOUS_MAINTENANCE_LOOP=true to enable)");
    return;
  }

  const intervalMinutes = Math.max(
    5,
    parseInt(process.env.AUTONOMOUS_MAINTENANCE_INTERVAL_MINUTES || "60", 10) || 60
  );
  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`Maintenance loop: enabled (every ${intervalMinutes} minutes)`);
  runMaintenanceCycle(WORKSPACE_PATHS).catch((error) => {
    console.error("Initial maintenance cycle failed:", error);
  });

  maintenanceTimer = setInterval(() => {
    runMaintenanceCycle(WORKSPACE_PATHS).catch((error) => {
      console.error("Maintenance cycle failed:", error);
    });
  }, intervalMs);
}

// ============================================================
// START
// ============================================================

async function main(): Promise<void> {
  if (!BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN not set!");
    console.log("\nTo set up:");
    console.log("1. Message @BotFather on Telegram");
    console.log("2. Create a new bot with /newbot");
    console.log("3. Copy the token to .env");
    process.exit(1);
  }

  await ensureWorkspaceBootstrap(WORKSPACE_PATHS, { logPrefix: "[main]" });
  session = await loadSession();

  if (!(await acquireLock())) {
    console.error("Could not acquire lock. Another instance may be running.");
    process.exit(1);
  }

  setupSignalHandlers();

  console.log("Starting Codex Telegram Relay...");
  console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
  console.log(`Workspace: ${WORKSPACE_DIR}`);
  console.log(`Agents file: ${AGENTS_FILE}`);
  console.log(`Reasoning effort: ${CODEX_REASONING_EFFORT}`);
  console.log(`Autonomous mode: ${AUTONOMOUS_V3_ENABLED ? "v3" : "legacy"}`);
  console.log(
    `Access mode: ${
      CODEX_FULL_ACCESS ? "full access (approvals + sandbox bypassed)" : `sandbox=${CODEX_SANDBOX}`
    }`
  );

  if (shouldEnableVoiceRelay()) {
    try {
      voiceRelayServer = startVoiceRelay("[main]");
    } catch (error) {
      console.error("Voice relay failed to start:", error);
    }
  } else {
    console.log("Voice relay: disabled (set VOICE_RELAY_ENABLED=true to force-enable)");
  }

  startMaintenanceLoop();

  const bot = new Bot(BOT_TOKEN);
  registerBotHandlers(bot);
  startBackgroundTaskLoop(bot.api);

  bot.start({
    onStart: () => {
      console.log("Bot is running!");
    },
  });
}

await main();
