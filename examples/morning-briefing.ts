/**
 * Morning Briefing Example
 *
 * Sends a daily summary via Telegram at a scheduled time.
 * Customize this for your own morning routine.
 *
 * Schedule this with:
 * - macOS: launchd (see daemon/morning-briefing.plist)
 * - Linux: cron or systemd timer
 * - Windows: Task Scheduler
 *
 * Run manually: bun run examples/morning-briefing.ts
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const TELEGRAM_PARSE_MODE = "MarkdownV2" as const;
const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;
const TELEGRAM_MD_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!]/g;

// ============================================================
// TELEGRAM HELPER
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  for (const chunk of splitTelegramChunks(message)) {
    const sent = await sendTelegramChunk(chunk);
    if (!sent) return false;
  }
  return true;
}

function splitTelegramChunks(message: string): string[] {
  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (splitIndex === -1) splitIndex = TELEGRAM_MAX_MESSAGE_LENGTH;

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

function normalizeMarkdownForTelegram(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/gs, "*$1*");
}

function escapeMarkdownV2(text: string): string {
  return text.replace(TELEGRAM_MD_V2_SPECIAL_CHARS, "\\$&");
}

async function callTelegramApi(text: string, parseMode?: typeof TELEGRAM_PARSE_MODE): Promise<boolean> {
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
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

async function sendTelegramChunk(chunk: string): Promise<boolean> {
  const normalized = normalizeMarkdownForTelegram(chunk);

  if (await callTelegramApi(normalized, TELEGRAM_PARSE_MODE)) {
    return true;
  }

  const escaped = escapeMarkdownV2(normalized);
  if (escaped.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    if (await callTelegramApi(escaped, TELEGRAM_PARSE_MODE)) {
      return true;
    }
  }

  return callTelegramApi(chunk);
}

// ============================================================
// DATA FETCHERS (customize these for your sources)
// ============================================================

async function getUnreadEmails(): Promise<string> {
  // Example: Use Gmail API, IMAP, or MCP tool
  // Return a summary of unread emails

  // Placeholder - replace with your implementation
  return "- 3 unread emails (1 urgent from client)";
}

async function getCalendarEvents(): Promise<string> {
  // Example: Use Google Calendar API or MCP tool
  // Return today's events

  // Placeholder
  return "- 10:00 Team standup\n- 14:00 Client call";
}

async function getActiveGoals(): Promise<string> {
  // Load from your persistence layer (Supabase, JSON file, etc.)

  // Placeholder
  return "- Finish video edit\n- Review PR";
}

async function getWeather(): Promise<string> {
  // Optional: Weather API

  // Placeholder
  return "Sunny, 22°C";
}

async function getAINews(): Promise<string> {
  // Optional: Pull from X/Twitter, RSS, or news API
  // Use Grok, Perplexity, or web search

  // Placeholder
  return "- OpenAI released GPT-5\n- Anthropic launches new feature";
}

// ============================================================
// BUILD BRIEFING
// ============================================================

async function buildBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const sections: string[] = [];

  // Header
  sections.push(`🌅 **Good Morning!**\n${dateStr}\n`);

  // Weather (optional)
  try {
    const weather = await getWeather();
    sections.push(`☀️ **Weather**\n${weather}\n`);
  } catch (e) {
    console.error("Weather fetch failed:", e);
  }

  // Calendar
  try {
    const calendar = await getCalendarEvents();
    if (calendar) {
      sections.push(`📅 **Today's Schedule**\n${calendar}\n`);
    }
  } catch (e) {
    console.error("Calendar fetch failed:", e);
  }

  // Emails
  try {
    const emails = await getUnreadEmails();
    if (emails) {
      sections.push(`📧 **Inbox**\n${emails}\n`);
    }
  } catch (e) {
    console.error("Email fetch failed:", e);
  }

  // Goals
  try {
    const goals = await getActiveGoals();
    if (goals) {
      sections.push(`🎯 **Active Goals**\n${goals}\n`);
    }
  } catch (e) {
    console.error("Goals fetch failed:", e);
  }

  // AI News (optional)
  try {
    const news = await getAINews();
    if (news) {
      sections.push(`🤖 **AI News**\n${news}\n`);
    }
  } catch (e) {
    console.error("News fetch failed:", e);
  }

  // Footer
  sections.push("---\n_Reply to chat or say \"call me\" for voice briefing_");

  return sections.join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building morning briefing...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const briefing = await buildBriefing();

  console.log("Sending briefing...");
  const success = await sendTelegram(briefing);

  if (success) {
    console.log("Briefing sent successfully!");
  } else {
    console.error("Failed to send briefing");
    process.exit(1);
  }
}

main();

// ============================================================
// LAUNCHD PLIST FOR SCHEDULING (macOS)
// ============================================================
/*
Save this as ~/Library/LaunchAgents/com.codex.morning-briefing.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codex.morning-briefing</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/morning-briefing.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/codex-telegram-relay</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/morning-briefing.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/morning-briefing.error.log</string>
</dict>
</plist>

Load with: launchctl load ~/Library/LaunchAgents/com.codex.morning-briefing.plist
*/

// ============================================================
// CRON FOR SCHEDULING (Linux)
// ============================================================
/*
Add to crontab with: crontab -e

# Run at 9:00 AM every day
0 9 * * * cd /path/to/codex-telegram-relay && /home/USER/.bun/bin/bun run examples/morning-briefing.ts >> /tmp/morning-briefing.log 2>&1
*/
