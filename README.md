# Codex Telegram Relay

**A pattern for running Codex as an always-on Telegram bot.**

> **This is a reference implementation, not a copy-paste solution.** Take the patterns here and build your own system tailored to your needs.

## What This Is

A minimal relay that connects Telegram to Codex CLI. You send a message on Telegram, the relay spawns `codex exec`, and sends the response back.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Telegram   │────▶│    Relay     │────▶│  Codex CLI   │
│    (you)     │◀────│  (always on) │◀────│   (spawned)  │
└──────────────┘     └──────────────┘     └──────────────┘
```

## Why This Approach?

| Approach | Pros | Cons |
|----------|------|------|
| **This (CLI spawn)** | Simple, uses full Codex capabilities, all tools available | Spawns new process per message |
| API direct | Lower latency | No tool use, no MCP, less local context |
| Agent SDK | Production-ready, streaming | More complex setup |

The CLI spawn approach is the simplest way to get Codex tool use (shell, files, MCP, context) accessible via Telegram.

## Requirements

- [Bun](https://bun.sh/) runtime (or Node.js 18+)
- Codex CLI installed and authenticated (`codex` command available in `PATH`)
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Your Telegram User ID (from [@userinfobot](https://t.me/userinfobot))

## Quick Start

```bash
# Clone (or fork and customize)
git clone https://github.com/YOUR_USERNAME/codex-telegram-relay
cd codex-telegram-relay

# Install dependencies
bun install

# Copy and edit environment variables
cp .env.example .env
# Edit .env with your tokens

# Initialize workspace defaults (./.oka by default)
# Copies missing files from defaults/workspace without overwriting existing files.
SKIP_WHISPER_SETUP=true bash scripts/setup.sh

# Run
bun run src/relay.ts
```

The relay uses a workspace directory:
- default: `./.oka`
- override with `OKA_WORKSPACE_DIR` (for example `~/.oka`)

Runtime temp files, uploads, session state, and prompt config live there.

## Telnyx + ElevenLabs Phone Calls

The main app (`src/relay.ts`) can host phone-call endpoints in the same process. Voice relay auto-enables when Telnyx voice env vars are present, or you can force it with `VOICE_RELAY_ENABLED=true`.

```bash
# Start main app (Telegram + optional voice relay)
bun run src/relay.ts
```

### Required env vars for calls

```bash
TELNYX_API_KEY=...
TELNYX_CONNECTION_ID=...
TELNYX_FROM_NUMBER=+1...

VOICE_RELAY_PUBLIC_BASE_URL=https://YOUR_PUBLIC_URL
```

### Telnyx setup

- For outbound programmatic calls, the relay calls Telnyx API directly.
- For inbound "call the bot" flow with ElevenLabs agent, configure Telnyx SIP trunk in ElevenLabs dashboard.
- Optional webhook URL in Telnyx (for status logging): `https://YOUR_PUBLIC_URL/telnyx/webhook`

### Outbound calls

```bash
# From CLI
bun run voice:call -- +15551234567

# Or via API (optional auth)
curl -X POST https://YOUR_PUBLIC_URL/telnyx/outbound/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $VOICE_RELAY_AUTH_TOKEN" \
  -d '{"to":"+15551234567"}'
```

### Local testing

Use an HTTPS tunnel so Telnyx can reach your machine:

```bash
ngrok http 8787
```

Then set `VOICE_RELAY_PUBLIC_BASE_URL` to the ngrok HTTPS URL.

## Prompt Files

Edit prompt files directly:
- Main chat prompt:
  default (preferred): `~/.oka/OKA.md`
  fallback/backward-compatible: `~/.oka/AGENTS.md`
  local dev (`bun run dev`): `./.oka/OKA.md` (or `./.oka/AGENTS.md`)
- Heartbeat prompt (used by relay's built-in scheduler):
  default: `~/.oka/HEARTBEAT.md`
  local dev with `OKA_WORKSPACE_DIR=.oka`: `./.oka/HEARTBEAT.md`

The relay replaces:
- `{{USER_MESSAGE}}` with the incoming Telegram content
- `{{CURRENT_TIME}}` with local time
- `{{TIMEZONE}}` with local timezone

This makes prompt tuning a file edit instead of a code change.

## Cross-Platform "Always On" Setup

The relay needs to run continuously. Here's how on each platform:

### macOS (LaunchAgent)

LaunchAgent keeps the bot running and restarts it if it crashes.

```bash
# Copy the template
cp daemon/launchagent.plist ~/Library/LaunchAgents/com.codex.telegram-relay.plist

# Edit paths in the plist to match your setup
nano ~/Library/LaunchAgents/com.codex.telegram-relay.plist

# Load it
launchctl load ~/Library/LaunchAgents/com.codex.telegram-relay.plist

# Check status
launchctl list | grep codex

# View logs
tail -f ~/Library/Logs/codex-telegram-relay.log
```

**To stop:** `launchctl unload ~/Library/LaunchAgents/com.codex.telegram-relay.plist`

### Linux (systemd)

```bash
# Copy the template
sudo cp daemon/codex-relay.service /etc/systemd/system/codex-relay.service

# Edit paths and user
sudo nano /etc/systemd/system/codex-relay.service

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable codex-relay
sudo systemctl start codex-relay

# Check status
sudo systemctl status codex-relay

# View logs
journalctl -u codex-relay -f
```

### Windows (Task Scheduler)

**Option 1: Task Scheduler (built-in)**

1. Open Task Scheduler (`taskschd.msc`)
2. Create Basic Task
3. Trigger: "When the computer starts"
4. Action: Start a program
   - Program: `C:\Users\YOU\.bun\bin\bun.exe`
   - Arguments: `run src/relay.ts`
   - Start in: `C:\path\to\codex-telegram-relay`
5. In Properties, check "Run whether user is logged on or not"
6. In Settings, check "Restart if the task fails"

**Option 2: PM2 (recommended)**

PM2 works on all platforms and handles restarts, logs, and monitoring.

```bash
# Install PM2
npm install -g pm2

# Start the relay
pm2 start src/relay.ts --interpreter bun --name codex-relay

# Save the process list
pm2 save

# Setup startup script (run the command it outputs)
pm2 startup
```

**Option 3: NSSM (Windows Service)**

[NSSM](https://nssm.cc/) turns any script into a Windows service.

```bash
# Download NSSM, then:
nssm install codex-relay "C:\Users\YOU\.bun\bin\bun.exe" "run src/relay.ts"
nssm set codex-relay AppDirectory "C:\path\to\codex-telegram-relay"
nssm start codex-relay
```

## Architecture

```
src/
  relay.ts          # Core relay (what you customize)

examples/
  morning-briefing.ts   # Scheduled daily summary
  memory.ts             # Persistent memory pattern
  supabase-schema.sql   # Optional: cloud persistence

daemon/
  launchagent.plist     # macOS daemon config
  codex-relay.service   # Linux systemd config
```

## The Core Pattern

The relay does three things:

1. **Listen** for Telegram messages
2. **Spawn** Codex CLI with the message
3. **Send** the response back

```typescript
// Simplified core pattern
bot.on("message:text", async (ctx) => {
  const response = await spawnCodex(ctx.message.text);
  await ctx.reply(response);
});

async function spawnCodex(prompt: string): Promise<string> {
  const proc = spawn([
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "exec",
    "--json",
    "-c",
    "model_reasoning_effort=\"low\"",
    prompt
  ]);
  const output = await new Response(proc.stdout).text();
  return output;
}
```

That's the entire pattern. Everything else is enhancement.

## Enhancements You Can Add

### Security (Required)
```typescript
// Only respond to your user ID
if (ctx.from?.id.toString() !== process.env.TELEGRAM_USER_ID) {
  return; // Ignore unauthorized users
}
```

### Session Continuity
```typescript
// Resume conversations with codex exec resume
const proc = spawn([
  "codex",
  "--dangerously-bypass-approvals-and-sandbox",
  "exec",
  "--json",
  "resume",
  sessionId,
  prompt
]);
```

### Voice Messages
```typescript
// Transcribe with Whisper/Gemini, send to Codex
const transcription = await transcribe(voiceFile);
const response = await spawnCodex(`[Voice message]: ${transcription}`);
```

### Images
```typescript
// Codex can see images if you pass the path
const response = await spawnCodex(`Analyze this image: ${imagePath}`);
```

### Persistent Memory
```typescript
// Add context to every prompt
const memory = await loadMemory();
const fullPrompt = `
Context: ${memory.facts.join(", ")}
Goals: ${memory.goals.join(", ")}

User: ${prompt}
`;
```

### Scheduled Tasks
```typescript
// Run briefings via cron/launchd
// See examples/morning-briefing.ts
```

## Examples Included

### Morning Briefing (`examples/morning-briefing.ts`)

Sends a daily summary at a scheduled time:
- Unread emails
- Calendar for today
- Active goals
- Whatever else you want

Schedule it with cron (Linux), launchd (Mac), or Task Scheduler (Windows).

### Heartbeat Scheduler (built into relay)

The relay process runs periodic heartbeat checks in-process (no external cron/task required):
- Controlled by `HEARTBEAT_ENABLED` (default `true`)
- Interval set by `HEARTBEAT_INTERVAL_MINUTES` (default `30`)
- Optional startup run with `HEARTBEAT_RUN_ON_START` (default `true`)

Codex decides IF and WHAT to say.
Prompt source: `~/.oka/HEARTBEAT.md` (override with `HEARTBEAT_FILE`).

### Memory Persistence (`examples/memory.ts`)

Pattern for remembering facts and goals across sessions:
- Local JSON file (simple)
- Supabase (cloud, searchable)
- Any database you prefer

## Environment Variables

```bash
# Required
TELEGRAM_BOT_TOKEN=       # From @BotFather
TELEGRAM_USER_ID=         # From @userinfobot (for security)

# Optional - Codex defaults
CODEX_PATH=codex                      # Path to codex CLI (if not in PATH)
CODEX_REASONING_EFFORT=low            # low | medium | high
CODEX_FULL_ACCESS=true                # true => bypass sandbox + approvals
CODEX_SANDBOX=danger-full-access      # Used only when CODEX_FULL_ACCESS=false
CODEX_MODEL=                          # Optional model override

# Optional - Workspace + prompt
OKA_WORKSPACE_DIR=~/.oka              # Workspace root for temp/uploads/session/config
AGENTS_FILE=~/.oka/OKA.md             # Main relay prompt file (preferred)
HEARTBEAT_FILE=~/.oka/HEARTBEAT.md    # Heartbeat prompt used by built-in scheduler
HEARTBEAT_ENABLED=true                # Built-in heartbeat scheduler enabled
HEARTBEAT_INTERVAL_MINUTES=30         # Run heartbeat every X minutes
HEARTBEAT_RUN_ON_START=true           # Run one heartbeat check on relay start
PROMPT_FILE=~/.oka/OKA.md             # Backward-compatible alias for AGENTS_FILE
RELAY_DIR=~/.oka                      # Backward-compatible alias for OKA_WORKSPACE_DIR

# Optional - Features
SUPABASE_URL=             # For cloud memory persistence
SUPABASE_ANON_KEY=        # For cloud memory persistence
GEMINI_API_KEY=           # For voice transcription
ELEVENLABS_API_KEY=       # For voice responses

# Optional - Telnyx + ElevenLabs phone-call relay
VOICE_RELAY_HOST=0.0.0.0
VOICE_RELAY_PORT=8787
VOICE_RELAY_PUBLIC_BASE_URL=      # Public HTTPS URL for Telnyx webhooks
VOICE_RELAY_AUTH_TOKEN=           # Optional bearer token for outbound API
TELNYX_API_KEY=
TELNYX_CONNECTION_ID=
TELNYX_FROM_NUMBER=+1...
```

## FAQ

**Q: Why spawn CLI instead of using the API directly?**

The CLI gives you everything: tools, MCP servers, context management, and command execution. The API is just the model.

**Q: Isn't spawning a process slow?**

It's ~1-2 seconds overhead. For a personal assistant, that's fine. If you need sub-second responses, use the Agent SDK instead.

**Q: Can I use this with other CLIs?**

Yes. The pattern works with any CLI that accepts prompts and returns text. Swap `codex` for your preferred tool.

**Q: How do I handle long-running tasks?**

Codex can take minutes for complex tasks. The relay handles this by waiting and then replying. Set appropriate timeouts.

**Q: What about MCP servers?**

They work. Codex uses your local Codex config (for example `~/.codex/config.toml`), so MCP servers remain available.

## Security Notes

1. **Always verify user ID** - Never run an open bot
2. **Don't commit `.env`** - It's in `.gitignore`
3. **Limit permissions** - Set `CODEX_FULL_ACCESS=false` if you do not want unrestricted command execution
4. **Review commands** - Codex can execute shell commands, be explicit about trust boundaries

## Credits

Built by [Goda](https://www.youtube.com/@godago) as part of the Personal AI Infrastructure project.

## License

MIT - Take it, customize it, make it yours.
