import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/main.ts",
    supervisor: "src/supervisor/supervisor.ts",
    "chat-bridge": "src/chat/chat-bridge.ts",
    "health-web": "src/health/health-web.ts",
    "wake-receiver": "src/openclaw/wake-receiver.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  external: ["@trpc/client", "superjson", "ws"],
});
