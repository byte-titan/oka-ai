import { readFile } from "fs/promises";
import { join } from "path";
import { callLlm, getLlmProvider } from "./llm";
import { resolvePath } from "./utils/path";
import { sendChunkedTelegramWithFallback } from "./utils/telegram";

export interface HeartbeatSchedulerOptions {
  enabled: boolean;
  intervalMinutes: number;
  runOnStart: boolean;
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const WORKSPACE_DIR = resolvePath(
  process.env.OKA_WORKSPACE_DIR || join(process.env.HOME || "~", ".oka")
);
const HEARTBEAT_FILE_ENV = process.env.HEARTBEAT_FILE;
const HEARTBEAT_FILE = HEARTBEAT_FILE_ENV
  ? resolvePath(HEARTBEAT_FILE_ENV)
  : resolvePath(join(WORKSPACE_DIR, "HEARTBEAT.md"), WORKSPACE_DIR);

const HEARTBEAT_ENABLED = (process.env.HEARTBEAT_ENABLED || "true").toLowerCase() === "true";
const HEARTBEAT_RUN_ON_START =
  (process.env.HEARTBEAT_RUN_ON_START || "true").toLowerCase() === "true";
const HEARTBEAT_INTERVAL_MINUTES = Math.max(
  1,
  parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES || "30", 10) || 30
);

export function getHeartbeatFilePath(): string {
  return HEARTBEAT_FILE;
}

export async function assertHeartbeatFileExists(): Promise<void> {
  await readFile(HEARTBEAT_FILE, "utf-8");
}

export function getHeartbeatSchedulerConfig(): HeartbeatSchedulerOptions {
  return {
    enabled: HEARTBEAT_ENABLED,
    intervalMinutes: HEARTBEAT_INTERVAL_MINUTES,
    runOnStart: HEARTBEAT_RUN_ON_START,
  };
}

export function startHeartbeatScheduler(
  overrides?: Partial<HeartbeatSchedulerOptions>
): { stop: () => void } {
  const config: HeartbeatSchedulerOptions = {
    ...getHeartbeatSchedulerConfig(),
    ...(overrides || {}),
  };

  if (!config.enabled) {
    console.log("Heartbeat scheduler: disabled (set HEARTBEAT_ENABLED=true to enable)");
    return { stop: () => {} };
  }

  const intervalMs = Math.max(1, config.intervalMinutes) * 60 * 1000;
  let isRunning = false;

  const tick = async () => {
    if (isRunning) {
      console.log("Heartbeat scheduler: previous run still in progress, skipping this tick");
      return;
    }

    isRunning = true;
    try {
      await runHeartbeatOnce();
    } catch (error) {
      console.error("Heartbeat scheduler iteration failed:", error);
    } finally {
      isRunning = false;
    }
  };

  if (config.runOnStart) {
    queueMicrotask(() => {
      void tick();
    });
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  console.log(`Heartbeat scheduler: running every ${config.intervalMinutes} minute(s)`);

  return {
    stop: () => clearInterval(timer),
  };
}

export async function runHeartbeatOnce(): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("Heartbeat scheduler: TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID missing, skipping run");
    return;
  }

  const { shouldCheckin, message } = await askModelToDecide();

  if (!shouldCheckin || !message || message.toLowerCase() === "none") {
    console.log("Heartbeat: no check-in needed");
    return;
  }

  const success = await sendTelegram(message);
  if (!success) {
    console.error("Heartbeat: failed to send check-in");
    return;
  }

  console.log("Heartbeat: check-in sent");
}

async function askModelToDecide(): Promise<{ shouldCheckin: boolean; message: string }> {
  const prompt = await buildHeartbeatPrompt();

  try {
    const result = await callLlm(prompt);
    const text = result.response;

    const decisionMatch = text.match(/DECISION:\s*(YES|NO)/i);
    const messageMatch = text.match(/MESSAGE:\s*(.+?)(?=\nREASON:|$)/is);
    const reasonMatch = text.match(/REASON:\s*(.+)/is);

    const shouldCheckin = decisionMatch?.[1]?.toUpperCase() === "YES";
    const message = messageMatch?.[1]?.trim() || "";
    const reason = reasonMatch?.[1]?.trim() || "";

    console.log(`Heartbeat decision (${getLlmProvider()}): ${shouldCheckin ? "YES" : "NO"}`);
    if (reason) {
      console.log(`Heartbeat reason: ${reason}`);
    }

    return { shouldCheckin, message };
  } catch (error) {
    console.error("Heartbeat model error:", error);
    return { shouldCheckin: false, message: "" };
  }
}

async function buildHeartbeatPrompt(): Promise<string> {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hour = now.getHours();
  const timeContext = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const currentTime = now.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const template = await readFile(HEARTBEAT_FILE, "utf-8");

  return template
    .replaceAll("{{CURRENT_TIME}}", currentTime)
    .replaceAll("{{TIMEZONE}}", timezone)
    .replaceAll("{{TIME_CONTEXT}}", timeContext)
    .replaceAll("{{LAST_ACTIVITY}}", "unknown")
    .replaceAll("{{LAST_CHECKIN}}", "unknown")
    .replaceAll("{{GOALS}}", "none")
    .replaceAll("{{CALENDAR}}", "none")
    .replaceAll("{{PENDING_ITEMS}}", "none")
    .trim();
}

async function sendTelegram(message: string): Promise<boolean> {
  return sendChunkedTelegramWithFallback(message, (text, parseMode) =>
    callTelegramApi(text, parseMode)
  );
}

async function callTelegramApi(text: string, parseMode?: "MarkdownV2"): Promise<boolean> {
  try {
    const body: Record<string, string> = {
      chat_id: CHAT_ID,
      text,
    };

    if (parseMode) {
      body.parse_mode = parseMode;
    }

    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return response.ok;
  } catch {
    return false;
  }
}
