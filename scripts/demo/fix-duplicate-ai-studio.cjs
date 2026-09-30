// Demo DB only (DEMO_ENV_FILE): the per-business "AI Studio" designer users
// both carried the same display name, so the Designers list and the VA
// "Designer load" panel showed two identical rows. Rename (never delete) each
// to "AI Studio (<business>)". Idempotent.
const { neon } = require("@neondatabase/serverless");
require("dotenv").config({ path: process.env.DEMO_ENV_FILE });
const sql = neon(process.env.DEMO_DIRECT_URL);
(async () => {
  const rows = await sql.query(
    `update "user" u set name = 'AI Studio (' || b.name || ')'
       from businesses b
      where u.email = 'ai-studio+' || b.id || '@agent.invalid' and u.name = 'AI Studio'
      returning u.email, u.name`,
  );
  console.log(rows);
})();
