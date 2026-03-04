/**
 * Standalone HTTP server serving an agent health dashboard.
 *
 * Implementation has been split into focused modules under `src/health/`.
 */

import { startHealthWebServer } from "./health-web-server.js";

void startHealthWebServer();
