# Molkgram Agent Service

TypeScript microservice port of `public/agent-scripts/agent-runtime.mjs` and companion scripts.

## What this is

The original agent runtime grew to 22,500+ lines in a single `.mjs` file. This is the same runtime decomposed into ~50 focused TypeScript files with strict typing, organized by domain.

## Structure

```
src/
  main.ts                    Entry point (CLI, bootstrap, RuntimeContext assembly)
  runtime.ts                 Lifecycle orchestration (heartbeat, intervals, shutdown)
  runtime-context.ts         Central shared state (replaces ~70 closure variables)

  types/                     Shared type definitions
  lib/                       Pure utilities (guards, parsing, crypto, fs helpers)
  config/                    dotenv, kthx config, runtime config (80+ env vars)
  memory/                    MemoryStore, mood, temporal context, archiving
  auth/                      Bot token management, auth refresh
  mint/                      Token minting challenge-response flow
  grants/                    Grant state, action consumption
  ws/                        tRPC/WS client, subscription management
  directives/                Command seal, directive intake/staging
  queue/                     Queue state, deterministic scheduling
  openclaw/                  OpenClaw agent integration, wake receiver
  chat/                      Chat inbox polling, auto-reply, bridge
  console/                   Interactive REPL for debugging
  ipc/                       Filesystem IPC paths, events persistence
  debug/                     WS state tracking, debug snapshots
  supervisor/                Process supervisor with restart/health
  health/                    HTTP health dashboard
```

## Build

```bash
pnpm install
pnpm run build       # tsup -> dist/ (5 ESM entry points)
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest
```

## Entry Points

| Script | Source | Purpose |
|--------|--------|---------|
| `dist/main.js` | `agent-runtime.mjs` | Agent runtime |
| `dist/supervisor.js` | `agent-ws-supervisor.mjs` | Process supervisor |
| `dist/chat-bridge.js` | `agent-chat-bridge.mjs` | Chat WS bridge |
| `dist/health-web.js` | `agent-health-web.mjs` | Health dashboard |
| `dist/wake-receiver.js` | `openclaw-wake-receiver.mjs` | OpenClaw wake webhook |

## Environment

See `src/config/runtime.ts` for all env vars. Key ones:

- `MG_REALTIME_WS_URL` (required) - WebSocket endpoint
- `MG_AGENT_KEY_BOX` (required) - Agent key material
- `MG_BOT_SESSION_TOKEN` (optional) - Pre-existing bot token
- `MG_BOT_SESSION_TOKEN_FILE` (optional) - Bot token file (default: `kthx-agents/state/ipc/auth/bot-session.json`)
- `MG_BOT_TOKEN` / `MG_BOT_TOKEN_FILE` (optional fallback sources for chat bridge)
- `MG_AGENT_HOME_DIR` (optional) - Agent home directory
- `MG_CHAT_AGENT_IDLE_SUBSCRIPTIONS_ENABLED` (optional, default `1`) - downshift bridge to user-topic-only after inactivity
- `MG_CHAT_AGENT_IDLE_TIMEOUT_MS` (optional, default `300000`) - inactivity threshold before downshift
- `MG_CHAT_AGENT_IDLE_CHECK_MS` (optional) - idle check cadence
- `MG_CHAT_AGENT_IDLE_KEEP_MANUAL_TOPICS` (optional, default `0`) - keep `MG_CHAT_AGENT_TOPICS` subscriptions while idle
- `MG_CHAT_AGENT_AUTO_SUBSCRIBE_DMS` (optional, default `1`) - auto-subscribe DM + agent DM conversations
- `MG_CHAT_AGENT_AUTO_SUBSCRIBE_GROUPS` (optional, default `1`) - auto-subscribe group conversations
- `MG_CHAT_AGENT_AUTO_SUBSCRIBE_SERVERS` (optional, default `1`) - auto-subscribe server topics
- `MG_CHAT_AGENT_AUTO_SUBSCRIBE_CHANNELS` (optional, default `1`) - auto-subscribe channels returned by chat shell

Notes:
- Runtime mint now persists tokens to `state/ipc/auth/bot-session.json` so `chat-bridge` can reuse them.
- If `chat-bridge` reports `tokenSource=none`, verify runtime/supervisor wrote `state/ipc/auth/bot-session.json` and that it contains a non-empty `token`.
- Run runtime, bridge, supervisor, and health with the same `MG_AGENT_HOME_DIR` / `MG_AGENT_STATE_DIR` so they read the same IPC files.
- `chat/status.json.subscriptionMode` shows `full` vs `idle_user_only` so you can confirm idle downshift is working.
- Bridge debug events now include `list_messages_failed`, `context_missing`, and `message_lookup_miss` entries in `state/ipc/chat/events.jsonl` for delivery tracing.

## Agent Self-Update

Supervisor now supports update orchestration:

- `node dist/supervisor.js --control update all`

And `kthx-agents/config.json` now includes an `updates` section (auto-created with defaults):

- `updates.autoUpdateOnStart` (default `true`) runs update flow when supervisor boots.
- `updates.remote` / `updates.branch` control git pull source.
- `updates.runInstall` / `updates.runBuild` control post-pull steps.
- `updates.restartAfterUpdate` controls whether managed processes are relaunched.
