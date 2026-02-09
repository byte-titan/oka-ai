/**
 * Codex Telegram Relay
 *
 * Minimal relay that connects Telegram to Codex CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink, appendFile, access } from "fs/promises";
import { dirname, isAbsolute, join } from "path";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CODEX_PATH = process.env.CODEX_PATH || process.env.CLAUDE_PATH || "codex";
const WORKSPACE_DIR = resolvePath(
  process.env.OKA_WORKSPACE_DIR || process.env.RELAY_DIR || join(process.env.HOME || "~", ".oka")
);
const AGENTS_FILE = resolvePath(
  process.env.AGENTS_FILE || process.env.PROMPT_FILE || join(WORKSPACE_DIR, "AGENTS.md"),
  WORKSPACE_DIR
);
const LEGACY_PROMPT_FILE = resolvePath(join(WORKSPACE_DIR, "prompt.md"), WORKSPACE_DIR);
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || "low";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const CODEX_FULL_ACCESS = (process.env.CODEX_FULL_ACCESS || "true").toLowerCase() === "true";
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || "danger-full-access";
const WHISPER_CLI_PATH = resolvePath(
  process.env.WHISPER_CLI_PATH || join(process.cwd(), "tools/whisper.cpp/build/bin/whisper-cli")
);
const WHISPER_MODEL_PATH = resolvePath(
  process.env.WHISPER_MODEL_PATH || join(process.cwd(), "tools/whisper.cpp/models/ggml-base.bin")
);
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const WHISPER_LANG = process.env.WHISPER_LANG || "auto";
const WHISPER_THREADS = Math.max(1, parseInt(process.env.WHISPER_THREADS || "4", 10) || 4);
const WHISPER_KEEP_TEMP = (process.env.WHISPER_KEEP_TEMP || "false").toLowerCase() === "true";

// Directories
const TEMP_DIR = join(WORKSPACE_DIR, "temp");
const UPLOADS_DIR = join(WORKSPACE_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(WORKSPACE_DIR, "session.json");
const MEMORY_DIR = join(WORKSPACE_DIR, "memory");

interface SessionState {
  sessionId: string | null; // Codex thread_id
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

const DEFAULT_AGENTS_TEMPLATE = `
You are responding via Telegram. Keep responses concise and actionable.

Current time: {{CURRENT_TIME}}
Timezone: {{TIMEZONE}}

User: {{USER_MESSAGE}}
`.trim();

let promptLoadWarningShown = false;

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(WORKSPACE_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
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

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(WORKSPACE_DIR, { recursive: true });
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(MEMORY_DIR, { recursive: true });
await ensureAgentsTemplateFile();

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// CORE: Call Codex CLI
// ============================================================

async function callCodex(
  prompt: string,
  options?: { resume?: boolean }
): Promise<string> {
  const args = buildCodexCommand(prompt, options);

  console.log(`Calling Codex: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Pass through any env vars Codex might need
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Codex error:", stderr);
      return `Error: ${stderr || "Codex exited with code " + exitCode}`;
    }

    const parsed = parseCodexOutput(output);
    if (parsed.sessionId) {
      session.sessionId = parsed.sessionId;
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    if (!parsed.response) {
      return "No response from Codex.";
    }

    return parsed.response;
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Codex CLI`;
  }
}

function buildCodexCommand(prompt: string, options?: { resume?: boolean }): string[] {
  const args = [CODEX_PATH];

  if (CODEX_FULL_ACCESS) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-s", CODEX_SANDBOX);
  }

  args.push("exec", "--json", "-c", `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`);

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
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");

  // Add any context you want here
  const enrichedPrompt = await buildPrompt(text);

  const response = await callCodex(enrichedPrompt, { resume: true });
  await appendMemoryEntry("user", text);
  await appendMemoryEntry("assistant", response);
  await sendResponse(ctx, response);
});

// Voice messages (optional - requires transcription)
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

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    transcriptionPath = await prepareAudioForWhisper(filePath);
    const transcription = await transcribeWithLocalWhisper(transcriptionPath);
    if (!transcription) {
      await ctx.reply("I could not transcribe that voice message.");
      return;
    }

    const prompt = await buildPrompt(`[Voice transcription]\n${transcription}`);
    const codexResponse = await callCodex(prompt, { resume: true });

    await appendMemoryEntry("user", `[Voice] ${transcription}`);
    await appendMemoryEntry("assistant", codexResponse);
    await sendResponse(ctx, codexResponse);
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply(
      "Voice transcription failed. Check WHISPER_CLI_PATH and WHISPER_MODEL_PATH configuration."
    );
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

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Codex can read images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = await buildPrompt(`[Image: ${filePath}]\n\n${caption}`);

    const codexResponse = await callCodex(prompt, { resume: true });
    await appendMemoryEntry("user", `[Image] ${caption}`);
    await appendMemoryEntry("assistant", codexResponse);

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    await sendResponse(ctx, codexResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = await buildPrompt(`[File: ${filePath}]\n\n${caption}`);

    const codexResponse = await callCodex(prompt, { resume: true });
    await appendMemoryEntry("user", `[File] ${caption}`);
    await appendMemoryEntry("assistant", codexResponse);

    await unlink(filePath).catch(() => {});

    await sendResponse(ctx, codexResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// HELPERS
// ============================================================

function resolvePath(pathValue: string, relativeTo = process.cwd()): string {
  if (isAbsolute(pathValue)) return pathValue;
  if (pathValue.startsWith("~/")) {
    const home = process.env.HOME || "";
    return join(home, pathValue.slice(2));
  }
  return join(relativeTo, pathValue);
}

async function ensureAgentsTemplateFile(): Promise<void> {
  await mkdir(dirname(AGENTS_FILE), { recursive: true });
  try {
    await readFile(AGENTS_FILE, "utf-8");
    return;
  } catch {
    // Continue and initialize the template file below.
  }

  // One-time migration from legacy prompt.md file.
  try {
    const legacy = await readFile(LEGACY_PROMPT_FILE, "utf-8");
    await writeFile(AGENTS_FILE, legacy);
    return;
  } catch {
    // No legacy file found, use default template.
  }

  await writeFile(AGENTS_FILE, `${DEFAULT_AGENTS_TEMPLATE}\n`);
}

async function loadPromptTemplate(): Promise<string> {
  try {
    return await readFile(AGENTS_FILE, "utf-8");
  } catch (error) {
    if (!promptLoadWarningShown) {
      console.warn(
        `Could not read AGENTS file at ${AGENTS_FILE}. Using built-in template.`,
        error
      );
      promptLoadWarningShown = true;
    }
    return DEFAULT_AGENTS_TEMPLATE;
  }
}

async function buildPrompt(userMessage: string): Promise<string> {
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
  const memoryContext = await loadRecentMemoryContext(timezone);

  const prompt = template
    .replaceAll("{{CURRENT_TIME}}", timeStr)
    .replaceAll("{{TIMEZONE}}", timezone)
    .replaceAll("{{USER_MESSAGE}}", userMessage)
    .trim();

  if (!memoryContext) {
    return prompt;
  }

  return `${prompt}\n\nRecent memory context:\n${memoryContext}`;
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
    const proc = spawn(
      [FFMPEG_PATH, "-y", "-i", sourcePath, "-ar", "16000", "-ac", "1", wavPath],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
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

  // Keep timestamped output but strip leading timestamp windows.
  const cleaned = lines
    .map((line) =>
      line.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, "")
    )
    .join("\n")
    .trim();

  return cleaned;
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
      // Missing memory files are expected.
    }
  }

  return sections.join("\n\n").trim();
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
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

// ============================================================
// START
// ============================================================

console.log("Starting Codex Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Workspace: ${WORKSPACE_DIR}`);
console.log(`Agents file: ${AGENTS_FILE}`);
console.log(`Reasoning effort: ${CODEX_REASONING_EFFORT}`);
console.log(
  `Access mode: ${
    CODEX_FULL_ACCESS ? "full access (approvals + sandbox bypassed)" : `sandbox=${CODEX_SANDBOX}`
  }`
);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
