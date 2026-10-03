// Starts the built app on :3155 against the demo DB (env parsed with dotenv, never echoed).
const dotenv = require("dotenv");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const e = dotenv.parse(fs.readFileSync(os.homedir() + "/Documents/ai-employee-agent/.local/alphaos-demo.env"));
const mainEnv = (() => { try { return dotenv.parse(fs.readFileSync(__dirname + "/../../../../../.env.local")); } catch { return {}; } })();
const r2 = Object.fromEntries(["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter((k) => mainEnv[k]).map((k) => [k, mainEnv[k]]));
const env = { ...process.env, ...r2,
  DATABASE_URL: e.DEMO_DATABASE_URL, DIRECT_URL: e.DEMO_DIRECT_URL, ENCRYPTION_KEY: e.DEMO_ENCRYPTION_KEY,
  MOCK_INTEGRATIONS: "1", PRINT_PROVIDER_MOCK: "1", NOTIFICATIONS_ENABLED: "false", ALPHA_ACTIONS_ENABLED: "false",
  AUTH_SECRET: require("crypto").randomBytes(24).toString("hex"), AUTH_TRUST_HOST: "true", STAGING: "1", DEMO: "1", AUTH_URL: "http://localhost:3155", NEXT_PUBLIC_APP_URL: "http://localhost:3155", PORT: "3155" };
const mode = process.argv[2];
const args = mode === "build" ? ["next", "build"] : ["next", "start", "-p", "3155"];
const p = spawn("nice", ["-n", "8", "npx", ...args], { env, stdio: "inherit" });
p.on("exit", (c) => process.exit(c ?? 0));
