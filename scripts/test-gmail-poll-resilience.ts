/**
 * Gmail poller resilience:
 * - DRAFT history entries are skipped before fetch;
 * - 404/deleted messages do not abort the mailbox run;
 * - later valid inbound messages still land in messages.
 */
import "./load-env";

import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import ws from "ws";

import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import { businesses, messages, notifications, users } from "../lib/db/schema";
import { GmailApiError } from "../lib/integrations/gmail";
import { processHistoryMessages } from "../lib/integrations/gmail/inbound";
import type { GmailMessage } from "../lib/integrations/gmail/types";

let failures = 0;
const ids = {
  businessId: randomUUID(),
  vaId: randomUUID(),
};

function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

function gmailMessage(id: string, body: string): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Customer <customer@example.com>" },
        { name: "To", value: "orders@example.com" },
        { name: "Subject", value: "Re: PC99999" },
        { name: "Message-ID", value: `<${id}@example.com>` },
      ],
      body: { data: Buffer.from(body).toString("base64url"), size: body.length },
    },
  };
}

async function setup() {
  await withSystemContext(async (tx) => {
    const suffix = Date.now();
    await tx.insert(businesses).values({
      id: ids.businessId,
      name: "Gmail Poll Resilience",
      slug: `gmail-poll-resilience-${suffix}`,
    });
    await tx.insert(users).values({
      id: ids.vaId,
      email: `gmail-poll-va-${suffix}@example.com`,
      name: "Gmail Poll VA",
      role: "va",
    });
  });
}

async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    await ownerDb.transaction(async (tx) => {
      await tx.delete(notifications).where(eq(notifications.businessId, ids.businessId));
      await tx.delete(messages).where(eq(messages.businessId, ids.businessId));
      await tx.delete(users).where(eq(users.id, ids.vaId));
      await tx.delete(businesses).where(eq(businesses.id, ids.businessId));
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  await setup();
  try {
    const fetched: string[] = [];
    const client = {
      async getMessage(id: string): Promise<GmailMessage> {
        fetched.push(id);
        if (id === "missing") throw new GmailApiError(404, "Requested entity was not found");
        return gmailMessage(id, "Looks good, thank you.");
      },
    };

    const summary = await processHistoryMessages({
      client,
      businessId: ids.businessId,
      selfAddress: "orders@example.com",
      historyMessages: [
        { id: "draft", threadId: "thread-draft", labelIds: ["DRAFT"] },
        { id: "missing", threadId: "thread-missing", labelIds: ["INBOX"] },
        { id: "valid", threadId: "thread-valid", labelIds: ["INBOX"] },
      ],
    });

    const rows = await withSystemContext((tx) =>
      tx
        .select({
          gmailMessageId: messages.gmailMessageId,
          address: messages.address,
          subject: messages.subject,
          body: messages.body,
        })
        .from(messages)
        .where(eq(messages.businessId, ids.businessId)),
    );

    report(
      "draft history entries are skipped before fetch",
      !fetched.includes("draft") && summary.skippedReasons.draft === 1,
      JSON.stringify({ fetched, skippedReasons: summary.skippedReasons }),
    );
    report(
      "404 history entries do not abort later messages",
      summary.skippedReasons.notFound === 1 && summary.attached === 1 && rows.length === 1,
      JSON.stringify({ summary, rows }),
    );
    report(
      "valid message after 404 is inserted",
      rows[0]?.gmailMessageId === "valid" && rows[0]?.body === "Looks good, thank you.",
      JSON.stringify(rows[0]),
    );
  } finally {
    await cleanup();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("test-gmail-poll-resilience crashed:", error);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
