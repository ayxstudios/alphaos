// Helper for scripts/demo/seed-demo.sh: sets app_user's login password on the
// demo database (the same action scripts/staging/prepare.ts takes for
// staging; the role's GRANTs themselves come from lib/db/migrations, applied
// right before this runs). Reads DEMO_DIRECT_URL and DEMO_APP_USER_PASSWORD
// from the environment; never logs the password.
const { Pool, neonConfig } = require("@neondatabase/serverless");
const ws = require("ws");

neonConfig.webSocketConstructor = ws;

async function main() {
  const pool = new Pool({ connectionString: process.env.DEMO_DIRECT_URL, max: 1 });
  // ALTER ROLE ... PASSWORD does not accept a bind parameter (it's DDL, not
  // DML), so escape the password ourselves (double any single quotes) the
  // same way scripts/staging/prepare.ts does for its own dynamic SQL.
  const pw = process.env.DEMO_APP_USER_PASSWORD.replace(/'/g, "''");
  await pool.query(`alter role app_user with login password '${pw}'`);
  await pool.end();
  console.log("app_user password set");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
