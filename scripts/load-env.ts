// Side-effect module: load .env.local. Import this FIRST (before any module
// that reads env at import time, e.g. lib/db which builds its Pool from
// DATABASE_URL). Import order = evaluation order, so this runs first.
import { config } from "dotenv";

import { applyLocalNeonProxy } from "../lib/db/local-proxy";

config({ path: ".env.local" });
// Local/CI Postgres through scripts/ci/neon-local-proxy.mjs (no-op unless
// NEON_LOCAL_PROXY is set).
applyLocalNeonProxy();
