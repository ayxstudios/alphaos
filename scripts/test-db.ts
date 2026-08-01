import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local" });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set in .env.local");
  }

  const sql = neon(url);
  const rows = await sql`SELECT version()`;
  console.log(rows[0]?.version ?? rows);
}

main().catch((err) => {
  console.error("Database connection failed:", err.message);
  process.exit(1);
});
