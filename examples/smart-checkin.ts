/**
 * Smart Check-in Example
 *
 * A proactive assistant pattern where Codex decides:
 * - IF to check in (based on context)
 * - WHAT to say (based on goals, time, etc.)
 *
 * Run periodically (e.g., every 30 minutes) and Codex
 * intelligently decides whether to message you.
 *
 * Run: bun run examples/smart-checkin.ts
 */

import { spawn } from "bun";
import { mkdir, readFile, writeFile, stat } from "fs/promises";
import { dirname, isAbsolute, join } from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CODEX_PATH = process.env.CODEX_PATH || "codex";
const WORKSPACE_DIR = resolvePath(
  process.env.OKA_WORKSPACE_DIR || join(process.env.HOME || "~", ".oka")
);
const HEARTBEAT_LOOP = (process.env.HEARTBEAT_LOOP || "false").toLowerCase() === "true";
const HEARTBEAT_INTERVAL_MINUTES = Math.max(
  1,
  parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES || "30", 10) || 30
);
const HEARTBEAT_FILE = resolvePath(
  process.env.HEARTBEAT_FILE || join(WORKSPACE_DIR, "HEARTBEAT.md"),
  WORKSPACE_DIR
);
const STATE_FILE = resolvePath(
  process.env.CHECKIN_STATE_FILE || join(WORKSPACE_DIR, "checkin-state.json"),
  WORKSPACE_DIR
);
let heartbeatLoadWarningShown = false;

const DEFAULT_HEARTBEAT_TEMPLATE = `
You are a proactive AI assistant. Decide if you should check in with the user.

CONTEXT:
- Current time: {{CURRENT_TIME}} ({{TIME_CONTEXT}})
- {{LAST_ACTIVITY}}
- Last check-in: {{LAST_CHECKIN}}
- Active goals: {{GOALS}}
- Calendar: {{CALENDAR}}
- Pending follow-ups: {{PENDING_ITEMS}}

RULES:
1. Don't be annoying - max 2-3 check-ins per day
2. Only check in if there's a REASON (goal deadline, long silence, important event)
3. Be brief and helpful, not intrusive
4. Consider time of day (don't interrupt deep work hours)
5. If nothing important, respond with NO_CHECKIN

RESPOND IN THIS EXACT FORMAT:
DECISION: YES or NO
MESSAGE: [Your message if YES, or "none" if NO]
REASON: [Why you decided this]
`.trim();

// ============================================================
// STATE MANAGEMENT
// ============================================================

interface CheckinState {
  lastMessageTime: string; // Last time user messaged
  lastCheckinTime: string; // Last time we checked in
  pendingItems: string[]; // Things to follow up on
}

async function loadState(): Promise<CheckinState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastMessageTime: new Date().toISOString(),
      lastCheckinTime: "",
      pendingItems: [],
    };
  }
}

async function saveState(state: CheckinState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CONTEXT GATHERING
// ============================================================

async function getGoals(): Promise<string[]> {
  const todos = await readTodoItems();
  return todos.slice(0, 5);
}

async function getCalendarContext(): Promise<string> {
  const calendarPath = join(WORKSPACE_DIR, "CALENDAR.md");
  try {
    const content = await readFile(calendarPath, "utf-8");
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (lines.length === 0) return "None";
    return lines.join(" | ");
  } catch {
    return "None";
  }
}

async function getLastActivity(): Promise<string> {
  const lastMsg = await getLastUserActivityTime();
  if (!lastMsg) {
    return "Last message: unknown";
  }
  const now = new Date();
  const hoursSince = (now.getTime() - lastMsg.getTime()) / (1000 * 60 * 60);

  return `Last message: ${hoursSince.toFixed(1)} hours ago`;
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
        }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// CODEX DECISION
// ============================================================

async function askCodexToDecide(): Promise<{
  shouldCheckin: boolean;
  message: string;
}> {
  const state = await loadState();
  const goals = await getGoals();
  const calendar = await getCalendarContext();
  const activity = await getLastActivity();
  const pendingItems = await readTodoItems();

  const now = new Date();
  const hour = now.getHours();
  const timeContext =
    hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const prompt = await buildHeartbeatPrompt({
    currentTime: now.toLocaleTimeString(),
    timeContext,
    lastActivity: activity,
    lastCheckin: state.lastCheckinTime || "Never",
    goals: goals.join(", ") || "None",
    calendar,
    pendingItems: pendingItems.join(", ") || "None",
  });

  try {
    const proc = spawn(
      [
        CODEX_PATH,
        "--dangerously-bypass-approvals-and-sandbox",
        "exec",
        "--json",
        "-c",
        'model_reasoning_effort="low"',
        prompt,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const output = await new Response(proc.stdout).text();
    const text = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const event = JSON.parse(line) as {
            type?: string;
            item?: { type?: string; text?: string };
          };
          if (
            event.type === "item.completed" &&
            event.item?.type === "agent_message" &&
            typeof event.item.text === "string"
          ) {
            return event.item.text;
          }
          return "";
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join("\n");

    // Parse Codex response
    const decisionMatch = text.match(/DECISION:\s*(YES|NO)/i);
    const messageMatch = text.match(/MESSAGE:\s*(.+?)(?=\nREASON:|$)/is);
    const reasonMatch = text.match(/REASON:\s*(.+)/is);

    const shouldCheckin = decisionMatch?.[1]?.toUpperCase() === "YES";
    const message = messageMatch?.[1]?.trim() || "";
    const reason = reasonMatch?.[1]?.trim() || "";

    console.log(`Decision: ${shouldCheckin ? "YES" : "NO"}`);
    console.log(`Reason: ${reason}`);

    return { shouldCheckin, message };
  } catch (error) {
    console.error("Codex error:", error);
    return { shouldCheckin: false, message: "" };
  }
}

// ============================================================
// MAIN
// ============================================================

async function runCheckinOnce() {
  console.log("Running smart check-in...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }
  await ensureHeartbeatTemplateFile();
  console.log(`Heartbeat file: ${HEARTBEAT_FILE}`);

  const { shouldCheckin, message } = await askCodexToDecide();

  if (shouldCheckin && message && message !== "none") {
    console.log("Sending check-in...");
    const success = await sendTelegram(message);

    if (success) {
      // Update state
      const state = await loadState();
      state.lastCheckinTime = new Date().toISOString();
      await saveState(state);
      console.log("Check-in sent!");
    } else {
      console.error("Failed to send check-in");
    }
  } else {
    console.log("No check-in needed");
  }
}

async function main() {
  if (!HEARTBEAT_LOOP) {
    await runCheckinOnce();
    return;
  }

  const intervalMs = HEARTBEAT_INTERVAL_MINUTES * 60 * 1000;
  console.log(
    `Heartbeat loop enabled. Running every ${HEARTBEAT_INTERVAL_MINUTES} minute(s).`
  );

  while (true) {
    try {
      await runCheckinOnce();
    } catch (error) {
      console.error("Heartbeat loop iteration failed:", error);
    }
    await Bun.sleep(intervalMs);
  }
}

main();

interface HeartbeatPromptContext {
  currentTime: string;
  timeContext: string;
  lastActivity: string;
  lastCheckin: string;
  goals: string;
  calendar: string;
  pendingItems: string;
}

async function readTodoItems(): Promise<string[]> {
  const todoPath = join(WORKSPACE_DIR, "brain", "TODOS.md");
  try {
    const content = await readFile(todoPath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+\[\s\]\s+/.test(line))
      .map((line) => line.replace(/^[-*]\s+\[\s\]\s+/, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function getLastUserActivityTime(): Promise<Date | null> {
  const sessionPath = join(WORKSPACE_DIR, "session.json");
  try {
    const content = await readFile(sessionPath, "utf-8");
    const parsed = JSON.parse(content) as { lastActivity?: string };
    if (parsed.lastActivity) {
      return new Date(parsed.lastActivity);
    }
  } catch {
    // Fall through to memory file mtime.
  }

  const today = formatDateForFile(new Date());
  const memoryPath = join(WORKSPACE_DIR, "memory", `${today}.md`);
  try {
    const s = await stat(memoryPath);
    return s.mtime;
  } catch {
    return null;
  }
}

function formatDateForFile(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function resolvePath(pathValue: string, relativeTo = process.cwd()): string {
  if (isAbsolute(pathValue)) return pathValue;
  if (pathValue.startsWith("~/")) {
    const home = process.env.HOME || "";
    return join(home, pathValue.slice(2));
  }
  return join(relativeTo, pathValue);
}

async function ensureHeartbeatTemplateFile(): Promise<void> {
  await mkdir(dirname(HEARTBEAT_FILE), { recursive: true });
  try {
    await readFile(HEARTBEAT_FILE, "utf-8");
  } catch {
    await writeFile(HEARTBEAT_FILE, `${DEFAULT_HEARTBEAT_TEMPLATE}\n`);
  }
}

async function loadHeartbeatTemplate(): Promise<string> {
  try {
    return await readFile(HEARTBEAT_FILE, "utf-8");
  } catch (error) {
    if (!heartbeatLoadWarningShown) {
      console.warn(
        `Could not read HEARTBEAT file at ${HEARTBEAT_FILE}. Using built-in template.`,
        error
      );
      heartbeatLoadWarningShown = true;
    }
    return DEFAULT_HEARTBEAT_TEMPLATE;
  }
}

async function buildHeartbeatPrompt(context: HeartbeatPromptContext): Promise<string> {
  const template = await loadHeartbeatTemplate();

  return template
    .replaceAll("{{CURRENT_TIME}}", context.currentTime)
    .replaceAll("{{TIME_CONTEXT}}", context.timeContext)
    .replaceAll("{{LAST_ACTIVITY}}", context.lastActivity)
    .replaceAll("{{LAST_CHECKIN}}", context.lastCheckin)
    .replaceAll("{{GOALS}}", context.goals)
    .replaceAll("{{CALENDAR}}", context.calendar)
    .replaceAll("{{PENDING_ITEMS}}", context.pendingItems)
    .trim();
}

// ============================================================
// SCHEDULING
// ============================================================
/*
Run every 30 minutes:

CRON (Linux):
0,30 * * * * cd /path/to/relay && bun run examples/smart-checkin.ts

LAUNCHD (macOS) - save as ~/Library/LaunchAgents/com.codex.smart-checkin.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codex.smart-checkin</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOU/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/smart-checkin.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/relay</string>
    <key>StartInterval</key>
    <integer>1800</integer>  <!-- 30 minutes in seconds -->
</dict>
</plist>

WINDOWS Task Scheduler:
- Create task with "Daily" trigger
- Set to repeat every 30 minutes
*/
