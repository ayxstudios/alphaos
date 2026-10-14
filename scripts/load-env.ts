// Side-effect module: load .env.local. Import this FIRST (before any module
// that reads env at import time, e.g. lib/db which builds its Pool from
// DATABASE_URL). Import order = evaluation order, so this runs first.
import { config } from "dotenv";

import { applyLocalNeonProxy } from "../lib/db/local-proxy";
import { noteR2EnvSource } from "../lib/storage/r2-env-guard";

const loaded = config({ path: ".env.local" });
// dotenv never overrides a variable the parent process already set, so note any
// R2 setting that did not come from .env.local (storage refuses until fixed).
noteR2EnvSource(loaded.parsed);
// Local/CI Postgres through scripts/ci/neon-local-proxy.mjs (no-op unless
// NEON_LOCAL_PROXY is set).
applyLocalNeonProxy();
