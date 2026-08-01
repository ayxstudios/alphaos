// Side-effect module: load .env.local. Import this FIRST (before any module
// that reads env at import time, e.g. lib/db which builds its Pool from
// DATABASE_URL). Import order = evaluation order, so this runs first.
import { config } from "dotenv";

config({ path: ".env.local" });
