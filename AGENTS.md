# Repository Guidelines

## Project Structure & Module Organization
- `src/`: Runtime entrypoints.
- `src/relay.ts`: Main Telegram relay process.
- `src/voice-relay.ts`: Voice/Telnyx flow and outbound call support.
- `examples/`: Optional automation patterns (for example `morning-briefing.ts`, `memory.ts`).
- `defaults/workspace/`: Seed files copied into `~/.oka` or local `.oka` during setup.
- `daemon/`: Service templates for always-on deployment (`launchagent.plist`, `codex-relay.service`).
- `scripts/setup.sh`: Bootstraps workspace defaults and local prerequisites.

## Build, Test, and Development Commands
- `bun install`: Install dependencies.
- `cp .env.example .env`: Create local configuration.
- `SKIP_WHISPER_SETUP=true bash scripts/setup.sh`: Initialize workspace defaults without Whisper setup.
- `bun run src/relay.ts`: Run the relay directly.
- `bun run dev`: Local dev mode (`OKA_WORKSPACE_DIR=.oka`, watch mode, heartbeat loop).
- `bun run voice`: Start voice relay entrypoint.
- `bun run voice:call -- +15551234567`: Trigger outbound test call.

## Coding Style & Naming Conventions
- Language: TypeScript (ES modules, Bun runtime).
- Indentation: 2 spaces; keep lines readable and avoid dense inline logic.
- File names use kebab-case (`voice-relay.ts`), variables/functions use camelCase, types/interfaces use PascalCase.
- Prefer small, focused modules under `src/` and keep provider-specific behavior behind clear function boundaries.

## Testing Guidelines
- There is no committed automated test suite yet.
- Validate changes with targeted runtime checks:
  - `bun run src/relay.ts` for text relay paths.
  - `bun run voice` and `bun run voice:call -- <number>` for voice flow.
- If adding tests, place them near the feature (for example `src/__tests__/relay.test.ts`) and use descriptive names like `should_reject_unauthorized_user`.

## Commit & Pull Request Guidelines
- Follow concise, imperative commit subjects (for example `Add Telnyx voice relay support`, `Refine execution contracts`).
- Avoid vague commits like `wip` on shared branches.
- PRs should include:
  - What changed and why.
  - Environment/config changes (`.env` keys, daemon updates).
  - Manual verification steps and observed results.
  - Screenshots/log snippets only when behavior is user-visible or operational.

## Security & Configuration Tips
- Never commit `.env` or API keys.
- Keep Telegram access restricted to allowed user IDs.
- Use local `.oka/` during development to avoid mutating `~/.oka` production prompts.

## When you edit workspace markdown files make sure defaults/workspace/ is updated and vice versa
