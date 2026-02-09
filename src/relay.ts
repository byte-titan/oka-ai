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

const LOCK_FILE = join(WORKSPACE_DIR, "bot.lock");
let session: SessionState = { sessionId: null, lastActivity: new Date().toISOString() };
let promptLoadWarningShown = false;
let voiceRelayServer: Bun.Server | null = null;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

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
    voiceRelayServer?.stop(true);
    await releaseLock();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    maintenanceTimer && clearInterval(maintenanceTimer);
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

async function generateAssistantResponse(userMessage: string): Promise<string> {
  const policyPrompt = await buildPolicyPrompt(userMessage);

  // Fast-path small talk so simple greetings do not trigger task-graph orchestration.
  if (isSmallTalkMessage(userMessage)) {
    return callCodex(policyPrompt, { resume: true });
  }

  if (!AUTONOMOUS_V3_ENABLED) {
    const enrichedPrompt = await buildPromptWithMemory(userMessage, policyPrompt);
    return callCodex(enrichedPrompt, { resume: true });
  }

  const result = await runAutonomousV3(userMessage, WORKSPACE_PATHS, {
    callCodex,
  });
  return result.response;
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
    await ctx.reply(response);
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
    await ctx.reply(chunk);
  }
}

async function handleUserMessage(ctx: Context, userText: string, memoryLabel = userText): Promise<void> {
  await ctx.replyWithChatAction("typing");

  const response = await generateAssistantResponse(userText);
  await appendMemoryEntry("user", memoryLabel);
  await appendMemoryEntry("assistant", response);
  await sendResponse(ctx, response);
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
    await ctx.replyWithChatAction("typing");

    let filePath = "";
    let transcriptionPath = "";

    try {
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

      await handleUserMessage(ctx, `[Voice transcription]\n${transcription}`, `[Voice] ${transcription}`);
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
    await ctx.replyWithChatAction("typing");

    let filePath = "";
    try {
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const timestamp = Date.now();
      filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

      const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
      const buffer = await response.arrayBuffer();
      await writeFile(filePath, Buffer.from(buffer));

      const caption = ctx.message.caption || "Analyze this image.";
      await handleUserMessage(ctx, `[Image: ${filePath}]\n\n${caption}`, `[Image] ${caption}`);
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
    await ctx.replyWithChatAction("typing");

    let filePath = "";
    try {
      const file = await ctx.getFile();
      const timestamp = Date.now();
      const fileName = doc.file_name || `file_${timestamp}`;
      filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

      const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
      const buffer = await response.arrayBuffer();
      await writeFile(filePath, Buffer.from(buffer));

      const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
      await handleUserMessage(ctx, `[File: ${filePath}]\n\n${caption}`, `[File] ${caption}`);
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

  bot.start({
    onStart: () => {
      console.log("Bot is running!");
    },
  });
}

await main();
