# Windows Setup

Windows has several options for running the relay as an always-on service.

## Option 1: Task Scheduler (Built-in)

The simplest approach using Windows' built-in scheduler.

### Steps:

1. **Open Task Scheduler**
   - Press `Win + R`, type `taskschd.msc`, press Enter

2. **Create New Task**
   - Click "Create Task" (not "Create Basic Task" for more options)

3. **General Tab**
   - Name: `Codex Telegram Relay`
   - Check "Run whether user is logged on or not"
   - Check "Run with highest privileges"

4. **Triggers Tab**
   - New > At startup
   - Or: New > At log on (if you prefer)

5. **Actions Tab**
   - New > Start a program
   - Program: `C:\Users\YOUR_USERNAME\.bun\bin\bun.exe`
   - Arguments: `run src/relay.ts`
   - Start in: `C:\path\to\codex-telegram-relay`

6. **Settings Tab**
   - Check "If the task fails, restart every: 1 minute"
   - Check "Attempt to restart up to: 999 times"
   - Uncheck "Stop the task if it runs longer than"

7. **Click OK** and enter your password when prompted

### Commands:

```powershell
# Check if running
schtasks /query /tn "Codex Telegram Relay"

# Start manually
schtasks /run /tn "Codex Telegram Relay"

# Stop
schtasks /end /tn "Codex Telegram Relay"
```

---

## Option 2: PM2 (Cross-Platform, Recommended)

PM2 is a process manager that works on all platforms. Best option if you want consistent behavior across Mac/Linux/Windows.

### Install:

```powershell
npm install -g pm2
npm install -g pm2-windows-startup  # For auto-start on Windows
```

### Setup:

```powershell
# Navigate to relay directory
cd C:\path\to\codex-telegram-relay

# Start the relay
pm2 start src/relay.ts --interpreter bun --name codex-relay

# Save process list
pm2 save

# Setup Windows startup
pm2-startup install

# Other commands:
pm2 logs codex-relay      # View logs
pm2 restart codex-relay   # Restart
pm2 stop codex-relay      # Stop
pm2 delete codex-relay    # Remove
pm2 list                   # List all processes
```

---

## Option 3: NSSM (Windows Service)

NSSM (Non-Sucking Service Manager) turns any program into a proper Windows service.

### Install:

1. Download from https://nssm.cc/download
2. Extract to `C:\nssm`
3. Add to PATH or use full path

### Setup:

```powershell
# Install as service (opens GUI)
nssm install codex-relay

# Or via command line:
nssm install codex-relay "C:\Users\YOUR_USERNAME\.bun\bin\bun.exe" "run src/relay.ts"
nssm set codex-relay AppDirectory "C:\path\to\codex-telegram-relay"
nssm set codex-relay DisplayName "Codex Telegram Relay"
nssm set codex-relay Description "Telegram bot relay for Codex"
nssm set codex-relay Start SERVICE_AUTO_START

# Set environment variables
nssm set codex-relay AppEnvironmentExtra HOME=C:\Users\YOUR_USERNAME

# Start the service
nssm start codex-relay
```

### Commands:

```powershell
nssm status codex-relay   # Check status
nssm stop codex-relay     # Stop
nssm start codex-relay    # Start
nssm restart codex-relay  # Restart
nssm remove codex-relay   # Uninstall (confirm prompt)
```

---

## Troubleshooting

### Common Issues:

1. **"bun not found"**
   - Use full path: `C:\Users\YOUR_USERNAME\.bun\bin\bun.exe`
   - Or add Bun to system PATH

2. **"codex not found"**
   - Ensure Codex CLI is installed and authenticated
   - Use full path in CODEX_PATH env variable

3. **Environment variables not loading**
   - For Task Scheduler: Set them in the task's "Actions" settings
   - For PM2: Use `pm2 start --env production`
   - For NSSM: Use `nssm set codex-relay AppEnvironmentExtra VAR=value`

4. **Service won't start**
   - Check logs in Event Viewer > Windows Logs > Application
   - Run manually first to check for errors: `bun run src/relay.ts`

### Logs Location:

- Task Scheduler: Configure in task settings
- PM2: `%USERPROFILE%\.pm2\logs\`
- NSSM: Configure with `nssm set codex-relay AppStdout C:\path\to\log.txt`
