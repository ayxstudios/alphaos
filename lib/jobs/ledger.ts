import { eq, lt, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { jobRuns } from "@/lib/db/schema";

export const JOB_NAMES = {
  cronSync: "cron.sync",
  shopSync: "shop.sync",
  cronGmailPoll: "cron.gmail_poll",
  cronNotifications: "cron.notifications",
  cronRetention: "cron.retention",
  cronDailyHealth: "cron.daily_health",
  dailyHealthBusiness: "daily_health.business",
  shopifyWebhookImport: "shopify.webhook_import",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
export type JobRunStatus = "running" | "ok" | "failed" | "partial";

export type JobRunScope = {
  businessId?: string | null;
  shopId?: string | null;
};

export type JobRunFinish = {
  status: Exclude<JobRunStatus, "running">;
  itemsProcessed?: number;
  itemsFailed?: number;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
};

export async function startJobRun(input: {
  jobName: JobName;
  scope?: JobRunScope;
  metadata?: Record<string, unknown> | null;
}): Promise<string> {
  const [row] = await withSystemContext((tx) =>
    tx
      .insert(jobRuns)
      .values({
        jobName: input.jobName,
        businessId: input.scope?.businessId ?? null,
        shopId: input.scope?.shopId ?? null,
        metadata: input.metadata ?? null,
      })
      .returning({ id: jobRuns.id }),
  );
  return row.id;
}

export async function finishJobRun(runId: string, finish: JobRunFinish): Promise<void> {
  await withSystemContext((tx) =>
    tx
      .update(jobRuns)
      .set({
        finishedAt: new Date(),
        status: finish.status,
        itemsProcessed: finish.itemsProcessed ?? 0,
        itemsFailed: finish.itemsFailed ?? 0,
        error: finish.error ? finish.error.slice(0, 1000) : null,
        metadata: finish.metadata ?? null,
      })
      .where(eq(jobRuns.id, runId)),
  );
}

export async function failJobRun(
  runId: string,
  error: unknown,
  metadata?: Record<string, unknown> | null,
): Promise<void> {
  await finishJobRun(runId, {
    status: "failed",
    itemsFailed: 1,
    error: error instanceof Error ? error.message : String(error),
    metadata,
  });
}

export async function pruneJobRunsOlderThan(days: number): Promise<number> {
  const rows = await withSystemContext((tx) =>
    tx
      .delete(jobRuns)
      .where(lt(jobRuns.startedAt, sql`now() - (${days}::int * interval '1 day')`))
      .returning({ id: jobRuns.id }),
  );
  return rows.length;
}
