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
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import {
    writeFile,
    mkdir,
    readFile,
    unlink,
    access,
} from "fs/promises";
import { join } from "path";
import { shouldEnableVoiceRelay, startVoiceRelay } from "./voice-relay";
import {
    assertHeartbeatFileExists,
    getHeartbeatFilePath,
    getHeartbeatSchedulerConfig,
    startHeartbeatScheduler,
} from "./heartbeat";
import { parseCodexJsonStream } from "./utils/codex-events";
import { resolvePath } from "./utils/path";
import {
    splitTelegramChunks,
    sendTelegramWithFallback,
    TELEGRAM_MAX_MESSAGE_LENGTH,
} from "./utils/telegram";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CODEX_PATH = process.env.CODEX_PATH || process.env.CLAUDE_PATH || "codex";
const WORKSPACE_DIR = resolvePath(
    process.env.OKA_WORKSPACE_DIR ||
        process.env.RELAY_DIR ||
        join(process.env.HOME || "~", ".oka"),
);
const AGENTS_FILE_ENV = process.env.AGENTS_FILE || process.env.PROMPT_FILE;
const DEFAULT_OKA_FILE = resolvePath(
    join(WORKSPACE_DIR, "OKA.md"),
    WORKSPACE_DIR,
);
const DEFAULT_AGENTS_FILE = resolvePath(
    join(WORKSPACE_DIR, "AGENTS.md"),
    WORKSPACE_DIR,
);
const AGENTS_FILE = AGENTS_FILE_ENV
    ? resolvePath(AGENTS_FILE_ENV)
    : existsSync(DEFAULT_OKA_FILE)
      ? DEFAULT_OKA_FILE
      : DEFAULT_AGENTS_FILE;
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || "low";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const CODEX_FULL_ACCESS =
    (process.env.CODEX_FULL_ACCESS || "true").toLowerCase() === "true";
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || "danger-full-access";
const WHISPER_CLI_PATH = resolvePath(
    process.env.WHISPER_CLI_PATH ||
        join(process.cwd(), "tools/whisper.cpp/build/bin/whisper-cli"),
);
const WHISPER_MODEL_PATH = resolvePath(
    process.env.WHISPER_MODEL_PATH ||
        join(process.cwd(), "tools/whisper.cpp/models/ggml-base.bin"),
);
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const WHISPER_LANG = process.env.WHISPER_LANG || "auto";
const WHISPER_THREADS = Math.max(
    1,
    parseInt(process.env.WHISPER_THREADS || "4", 10) || 4,
);
const WHISPER_KEEP_TEMP =
    (process.env.WHISPER_KEEP_TEMP || "false").toLowerCase() === "true";

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

interface BotResponseEnvelope {
    text_response: string;
    commands_executed: string[];
    request_started_at: string;
    request_duration_ms: number;
    collected_user_facts: string[];
    learnings: string[];
    todos: TodoItem[];
}

interface TodoItem {
    id: string;
    title: string;
    priority: "low" | "medium" | "high";
    due_until: string | null;
    reminder: string | null;
    notes: string | null;
}

interface MemoryRecord {
    timestamp: string;
    role: "user" | "assistant";
    payload: unknown;
}

interface StoredMemoryRecord extends MemoryRecord {
    id: string;
    time: string;
    timezone: string;
}

let voiceRelayServer: Bun.Server<never> | null = null;
let heartbeatScheduler: { stop: () => void } | null = null;

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
        const existingLock = await readFile(LOCK_FILE, "utf-8").catch(
            () => null,
        );

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
    heartbeatScheduler?.stop();
    voiceRelayServer?.stop(true);
    await releaseLock();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    heartbeatScheduler?.stop();
    voiceRelayServer?.stop(true);
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
await ensureCoreWorkspaceFiles();

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
        await replyTelegram(ctx, "This bot is private.");
        return;
    }

    await next();
});

// ============================================================
// CORE: Call Codex CLI
// ============================================================

async function callCodex(
    prompt: string,
    options?: { resume?: boolean },
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

function buildCodexCommand(
    prompt: string,
    options?: { resume?: boolean },
): string[] {
    const args = [CODEX_PATH];

    if (CODEX_FULL_ACCESS) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
        args.push("-s", CODEX_SANDBOX);
    }

    args.push(
        "exec",
        "--json",
        "-c",
        `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
    );

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

function parseCodexOutput(output: string): {
    response: string;
    sessionId: string | null;
} {
    const { messages, sessionId } = parseCodexJsonStream(output, {
        includePlainText: true,
    });

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

    const requestStartedAt = new Date();
    const enrichedPrompt = await buildPrompt(
        text,
        requestStartedAt.toISOString(),
    );
    const rawResponse = await callCodex(enrichedPrompt, { resume: true });
    const botResponse = parseBotResponse(rawResponse, requestStartedAt);

    await appendMemoryRecord({
        timestamp: new Date().toISOString(),
        role: "user",
        payload: { text, source: "telegram:text" },
    });
    await appendMemoryRecord({
        timestamp: new Date().toISOString(),
        role: "assistant",
        payload: botResponse,
    });
    await sendResponse(ctx, botResponse.text_response);
});

// Voice messages (optional - requires transcription)
bot.on("message:voice", async (ctx) => {
    console.log("Voice message received");
    await ctx.replyWithChatAction("typing");
    let filePath = "";
    let transcriptionPath = "";

    try {
        const requestStartedAt = new Date();
        const voice = ctx.message.voice;
        const file = await ctx.api.getFile(voice.file_id);
        const timestamp = Date.now();
        filePath = join(UPLOADS_DIR, `voice_${timestamp}.ogg`);

        const response = await fetch(
            `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
        );
        const buffer = await response.arrayBuffer();
        await writeFile(filePath, Buffer.from(buffer));

        transcriptionPath = await prepareAudioForWhisper(filePath);
        const transcription =
            await transcribeWithLocalWhisper(transcriptionPath);
        if (!transcription) {
            await replyTelegram(
                ctx,
                "I could not transcribe that voice message.",
            );
            return;
        }

        const prompt = await buildPrompt(
            `[Voice transcription]\n${transcription}`,
            requestStartedAt.toISOString(),
        );
        const rawResponse = await callCodex(prompt, { resume: true });
        const botResponse = parseBotResponse(rawResponse, requestStartedAt);

        await appendMemoryRecord({
            timestamp: new Date().toISOString(),
            role: "user",
            payload: { text: transcription, source: "telegram:voice" },
        });
        await appendMemoryRecord({
            timestamp: new Date().toISOString(),
            role: "assistant",
            payload: botResponse,
        });
        await sendResponse(ctx, botResponse.text_response);
    } catch (error) {
        console.error("Voice error:", error);
        await replyTelegram(
            ctx,
            "Voice transcription failed. Check WHISPER_CLI_PATH and WHISPER_MODEL_PATH configuration.",
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
        const requestStartedAt = new Date();
        // Get highest resolution photo
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];
        const file = await ctx.api.getFile(photo.file_id);

        // Download the image
        const timestamp = Date.now();
        const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

        const response = await fetch(
            `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
        );
        const buffer = await response.arrayBuffer();
        await writeFile(filePath, Buffer.from(buffer));

        // Codex can read images via file path
        const caption = ctx.message.caption || "Analyze this image.";
        const prompt = await buildPrompt(
            `[Image: ${filePath}]\n\n${caption}`,
            requestStartedAt.toISOString(),
        );

        const rawResponse = await callCodex(prompt, { resume: true });
        const botResponse = parseBotResponse(rawResponse, requestStartedAt);

        await appendMemoryRecord({
            timestamp: new Date().toISOString(),
            role: "user",
            payload: {
                text: caption,
                source: "telegram:photo",
                image_path: filePath,
            },
        });
        await appendMemoryRecord({
            timestamp: new Date().toISOString(),
            role: "assistant",
            payload: botResponse,
        });

        // Cleanup after processing
        await unlink(filePath).catch(() => {});

        await sendResponse(ctx, botResponse.text_response);
    } catch (error) {
        console.error("Image error:", error);
        await replyTelegram(ctx, "Could not process image.");
    }
});

// Documents
bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    console.log(`Document: ${doc.file_name}`);
    await ctx.replyWithChatAction("typing");

    try {
        const requestStartedAt = new Date();
        const file = await ctx.getFile();
        const timestamp = Date.now();
        const fileName = doc.file_name || `file_${timestamp}`;
        const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

        const response = await fetch(
            `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
        );
        const buffer = await response.arrayBuffer();
        await writeFile(filePath, Buffer.from(buffer));

        const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
        const prompt = await buildPrompt(
            `[File: ${filePath}]\n\n${caption}`,
            requestStartedAt.toISOString(),
        );

        const rawResponse = await callCodex(prompt, { resume: true });
        const botResponse = parseBotResponse(rawResponse, requestStartedAt);

        await appendMemoryRecord({
            timestamp: new Date().toISOString(),
            role: "user",
            payload: {
                text: caption,
                source: "telegram:document",
                file_name: doc.file_name || "",
                file_path: filePath,
            },
        });
        await appendMemoryRecord({
            timestamp: new Date().toISOString(),
            role: "assistant",
            payload: botResponse,
        });

        await unlink(filePath).catch(() => {});

        await sendResponse(ctx, botResponse.text_response);
    } catch (error) {
        console.error("Document error:", error);
        await replyTelegram(ctx, "Could not process document.");
    }
});

// ============================================================
// HELPERS
// ============================================================

async function ensureCoreWorkspaceFiles(): Promise<void> {
    try {
        await readFile(AGENTS_FILE, "utf-8");
    } catch {
        console.error(
            `Required core file is missing or unreadable: ${AGENTS_FILE}`,
        );
        console.error(
            "Create this file in your workspace before starting the relay.",
        );
        if (!AGENTS_FILE_ENV) {
            console.error(
                `Defaults checked: ${DEFAULT_OKA_FILE} (preferred), then ${DEFAULT_AGENTS_FILE}.`,
            );
        }
        process.exit(1);
    }

    try {
        await assertHeartbeatFileExists();
    } catch {
        const heartbeatFilePath = getHeartbeatFilePath();
        console.error(
            `Required core file is missing or unreadable: ${heartbeatFilePath}`,
        );
        console.error(
            "Create this file in your workspace before starting the relay.",
        );
        process.exit(1);
    }
}

async function buildPrompt(
    userMessage: string,
    requestStartedAt: string,
): Promise<string> {
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

    const template = await readFile(AGENTS_FILE, "utf-8");
    const memoryContext = await loadRecentMemoryContext(timezone);

    const prompt = template
        .replaceAll("{{CURRENT_TIME}}", timeStr)
        .replaceAll("{{TIMEZONE}}", timezone)
        .replaceAll("{{USER_MESSAGE}}", userMessage)
        .trim();

    if (!memoryContext) {
        return `${prompt}\n\nRequest start timestamp: ${requestStartedAt}\n\n${getStructuredOutputContract()}`;
    }

    return `${prompt}\n\nRecent memory context:\n${memoryContext}\n\nRequest start timestamp: ${requestStartedAt}\n\n${getStructuredOutputContract()}`;
}

function getStructuredOutputContract(): string {
    return [
        "Output contract:",
        "- Return exactly one JSON object, no markdown fences and no extra text.",
        '- Required keys: "text_response", "commands_executed", "request_started_at", "request_duration_ms", "collected_user_facts", "learnings", "todos".',
        '- "text_response": string for Telegram user.',
        '- "commands_executed": array of strings, empty when no commands were run.',
        '- "request_started_at": copy the provided request start timestamp exactly.',
        '- "request_duration_ms": integer duration from request start until this response is ready.',
        '- "collected_user_facts": array of factual sentence strings learned about the user.',
        '- "learnings": array of future-useful lessons written as guidance for next time, ideally in "avoid X, do Y instead" form. Example: "Avoid calling cat for large logs; use tail -n 200 instead." If no meaningful learning occurred, return an empty array.',
        '- "todos": array of objects. Each todo object schema: {"id": string(uuid), "title": string, "priority": "low"|"medium"|"high", "due_until": string|null, "reminder": string|null, "notes": string|null}.',
        '- "todos.id": required UUID for this todo. Generate a new UUID when creating a todo.',
        '- "todos.title": concrete user-intent task title in imperative style.',
        '- "todos.priority": urgency level based on user intent; default to "medium" when unclear.',
        '- "todos.due_until": due date/time as text (for example "tomorrow 14:00") or null if unknown.',
        '- "todos.reminder": reminder time/instruction as text (for example "tomorrow 13:30") or null if none.',
        '- "todos.notes": free-text specifics/context for execution; include useful remembered constraints or prerequisites when relevant. Example: if user says "I need to pay the tax," notes can be "Remind the user to purchase a tax software license first."',
        "- Only add a todo when it is clear the user wants active help achieving a concrete outcome.",
        '- Never infer todos from ambiguous statements. If intent is uncertain, return "todos": [].',
        "- If unknown, return empty arrays. Never omit required keys.",
        "- Request start timestamp is provided below.",
    ].join("\n");
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

function parseBotResponse(
    raw: string,
    requestStartedAt: Date,
): BotResponseEnvelope {
    const now = new Date();
    const fallbackText = raw.trim() || "No response from Codex.";
    const extracted = extractJsonObject(raw);
    const parsed = extracted ? safeJsonParse(extracted) : safeJsonParse(raw);
    const durationMs = Math.max(0, now.getTime() - requestStartedAt.getTime());
    const startedAtIso = requestStartedAt.toISOString();

    const base: BotResponseEnvelope = {
        text_response: fallbackText,
        commands_executed: [],
        request_started_at: startedAtIso,
        request_duration_ms: durationMs,
        collected_user_facts: [],
        learnings: [],
        todos: [],
    };

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return base;
    }

    const obj = parsed as Record<string, unknown>;
    return {
        text_response: asString(obj.text_response, base.text_response),
        commands_executed: asStringArray(obj.commands_executed),
        request_started_at: startedAtIso,
        request_duration_ms: durationMs,
        collected_user_facts: asStringArray(obj.collected_user_facts),
        learnings: asStringArray(obj.learnings),
        todos: asTodoArray(obj.todos),
    };
}

function extractJsonObject(text: string): string | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return text.slice(start, end + 1).trim();
}

function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function asString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
}

function asTodoArray(value: unknown): TodoItem[] {
    if (!Array.isArray(value)) return [];
    const todos: TodoItem[] = [];

    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const todo = item as Record<string, unknown>;
        const title = asString(todo.title).trim();
        if (!title) continue;

        const priority =
            todo.priority === "low" ||
            todo.priority === "medium" ||
            todo.priority === "high"
                ? todo.priority
                : "medium";

        todos.push({
            id: asUuid(todo.id) ?? randomUUID(),
            title,
            priority,
            due_until: asNullableString(todo.due_until),
            reminder: asNullableString(todo.reminder),
            notes: asNullableString(todo.notes),
        });
    }

    return todos;
}

function asNullableString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function asUuid(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        trimmed,
    )
        ? trimmed
        : null;
}

async function appendMemoryRecord(record: MemoryRecord): Promise<void> {
    try {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const dateStamp = getDateStamp(timezone);
        const timeStamp = getTimeStamp(timezone);
        const filePath = join(MEMORY_DIR, `${dateStamp}.json`);
        const storedRecord: StoredMemoryRecord = {
            id: randomUUID(),
            time: timeStamp,
            timezone,
            timestamp: record.timestamp,
            role: record.role,
            payload: record.payload,
        };

        let existing: StoredMemoryRecord[] = [];
        try {
            const content = await readFile(filePath, "utf-8");
            const parsed = JSON.parse(content) as unknown;
            if (Array.isArray(parsed)) {
                existing = parsed.filter((item) => {
                    return item && typeof item === "object" && !Array.isArray(item);
                }) as StoredMemoryRecord[];
            }
        } catch {
            // Missing or invalid file: start a fresh array.
        }

        existing.push(storedRecord);
        await writeFile(filePath, JSON.stringify(existing, null, 2), "utf-8");
    } catch (error) {
        console.warn("Could not append memory record:", error);
    }
}

async function transcribeWithLocalWhisper(audioPath: string): Promise<string> {
    const outputBase = join(UPLOADS_DIR, `whisper_${Date.now()}`);
    const outputCandidates = [
        `${outputBase}.txt`,
        `${audioPath}.txt`,
        `${audioPath}.ogg.txt`,
    ];

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
            },
        );

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
            throw new Error(
                stderr || stdout || `whisper-cli exited with code ${exitCode}`,
            );
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

        const stdoutTranscript = extractTranscriptFromWhisperStdout(
            stdout,
            stderr,
        );
        if (stdoutTranscript) return stdoutTranscript;

        throw new Error(
            `Whisper completed but no transcript was produced. stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`,
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
            [
                FFMPEG_PATH,
                "-y",
                "-i",
                sourcePath,
                "-ar",
                "16000",
                "-ac",
                "1",
                wavPath,
            ],
            {
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            console.warn(
                "ffmpeg convert failed, falling back to original audio:",
                stderr,
            );
            return sourcePath;
        }
        return wavPath;
    } catch (error) {
        console.warn(
            "ffmpeg unavailable, falling back to original audio:",
            error,
        );
        return sourcePath;
    }
}

function extractTranscriptFromWhisperStdout(
    stdout: string,
    stderr: string,
): string {
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
            line.replace(
                /^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/,
                "",
            ),
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
            { year: "1970", month: "01", day: "01" },
        );
    const yesterdayStamp = `${yesterday.year}-${yesterday.month}-${yesterday.day}`;

    const days = [yesterdayStamp, today];
    const sections: string[] = [];

    for (const dayStamp of days) {
        const jsonPath = join(MEMORY_DIR, `${dayStamp}.json`);
        const mdPath = join(MEMORY_DIR, `${dayStamp}.md`);

        try {
            const content = await readFile(jsonPath, "utf-8");
            const parsed = JSON.parse(content) as unknown;
            if (!Array.isArray(parsed) || parsed.length === 0) {
                continue;
            }
            const tail = parsed.slice(-8);
            sections.push(`# ${jsonPath}\n${JSON.stringify(tail, null, 2)}`);
            continue;
        } catch {
            // Missing/invalid JSON memory files are expected.
        }

        try {
            const content = await readFile(mdPath, "utf-8");
            const lines = content.split("\n").filter(Boolean);
            const tail = lines.slice(-25).join("\n");
            if (tail) sections.push(`# ${mdPath}\n${tail}`);
        } catch {
            // Missing markdown memory files are expected.
        }
    }

    return sections.join("\n\n").trim();
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
    if (response.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
        await replyTelegram(ctx, response);
        return;
    }

    for (const chunk of splitTelegramChunks(response)) {
        await replyTelegram(ctx, chunk);
    }
}

async function replyTelegram(ctx: Context, text: string): Promise<void> {
    const sent = await sendTelegramWithFallback(
        text,
        async (body, parseMode) => {
            try {
                if (parseMode) {
                    await ctx.reply(body, { parse_mode: parseMode });
                } else {
                    await ctx.reply(body);
                }
                return true;
            } catch (error) {
                if (parseMode) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    if (!message.includes("can't parse entities")) {
                        console.warn(
                            `MarkdownV2 send failed, retrying fallback: ${message}`,
                        );
                    }
                }
                return false;
            }
        },
    );

    if (!sent) {
        await ctx.reply(text);
    }
}

// ============================================================
// START
// ============================================================

console.log("Starting Codex Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Workspace: ${WORKSPACE_DIR}`);
console.log(`Prompt file: ${AGENTS_FILE}`);
console.log(`Reasoning effort: ${CODEX_REASONING_EFFORT}`);
console.log(
    `Access mode: ${
        CODEX_FULL_ACCESS
            ? "full access (approvals + sandbox bypassed)"
            : `sandbox=${CODEX_SANDBOX}`
    }`,
);

if (shouldEnableVoiceRelay()) {
    try {
        voiceRelayServer = startVoiceRelay("[main]");
    } catch (error) {
        console.error("Voice relay failed to start:", error);
    }
} else {
    console.log(
        "Voice relay: disabled (set VOICE_RELAY_ENABLED=true to force-enable)",
    );
}

const heartbeatConfig = getHeartbeatSchedulerConfig();
heartbeatScheduler = startHeartbeatScheduler(heartbeatConfig);

bot.start({
    onStart: () => {
        console.log("Bot is running!");
    },
});
