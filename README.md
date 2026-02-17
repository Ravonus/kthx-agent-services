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
- `MG_AGENT_HOME_DIR` (optional) - Agent home directory
