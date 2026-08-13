import { and, eq, inArray } from "drizzle-orm";

import { anthropicFeaturesEnabled } from "@/lib/ai/anthropic";
import { withSystemContext } from "@/lib/db";
import { businesses, dailyHealthReports, notifications, users } from "@/lib/db/schema";
import { GmailClient, GmailNotConnectedError, GmailReauthRequiredError } from "@/lib/integrations/gmail";
import { appUrl } from "@/lib/urls";
import {
  HEALTH_TIME_ZONE,
  loadHealthMetricsForSystem,
  type CountLink,
  type HealthMetrics,
} from "@/lib/health/daily-report";
import {
  ensureDailyHealthReportForSystem,
  loadDailyNarrativeForSystem,
  type NarrativeResult,
} from "@/lib/health/narrative";

export type DailyHealthDeliveryResult = {
  checkedAt: string;
  localTime: string;
  skippedForLocalTime: boolean;
  processed: number;
  sent: number;
  skippedAlreadySent: number;
  failed: number;
  businesses: {
    businessId: string;
    businessName: string;
    status: "sent" | "failed" | "skipped_already_sent";
    recipients: number;
    error?: string;
  }[];
};

type BusinessSetting = {
  id: string;
  name: string;
  recipientIds: string[];
};

type Recipient = {
  id: string;
  email: string;
  name: string | null;
};

function melbourneParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: HEALTH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    label: `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")} ${HEALTH_TIME_ZONE}`,
  };
}

export function shouldRunDailyHealthDeliveryAt(date: Date): boolean {
  return melbourneParts(date).hour === "07";
}

export async function deliverDailyHealthReports(opts: {
  now?: Date;
  force?: boolean;
} = {}): Promise<DailyHealthDeliveryResult> {
  const now = opts.now ?? new Date();
  const local = melbourneParts(now);
  const shouldRun = opts.force || shouldRunDailyHealthDeliveryAt(now);
  const result: DailyHealthDeliveryResult = {
    checkedAt: now.toISOString(),
    localTime: local.label,
    skippedForLocalTime: !shouldRun,
    processed: 0,
    sent: 0,
    skippedAlreadySent: 0,
    failed: 0,
    businesses: [],
  };
  if (!shouldRun) return result;

  const settings = await withSystemContext((tx) =>
    tx
      .select({
        id: businesses.id,
        name: businesses.name,
        recipientIds: businesses.dailyHealthEmailRecipientIds,
      })
      .from(businesses)
      .where(eq(businesses.dailyHealthEmailEnabled, true))
      .orderBy(businesses.name),
  );

  for (const business of settings) {
    result.processed += 1;
    const delivery = await deliverForBusiness({
      id: business.id,
      name: business.name,
      recipientIds: business.recipientIds ?? [],
    });
    result.businesses.push(delivery);
    if (delivery.status === "sent") result.sent += 1;
    else if (delivery.status === "skipped_already_sent") result.skippedAlreadySent += 1;
    else result.failed += 1;
  }
  return result;
}

async function deliverForBusiness(business: BusinessSetting): Promise<DailyHealthDeliveryResult["businesses"][number]> {
  const metrics = await loadHealthMetricsForSystem({
    kind: "business",
    businessId: business.id,
    businessName: business.name,
  });
  const narrative = anthropicFeaturesEnabled() ? await loadDailyNarrativeForSystem(metrics) : null;
  if (!narrative) await ensureDailyHealthReportForSystem(metrics);
  const recipients = await loadRecipients(business.recipientIds);

  if (await alreadyEmailed(business.id, metrics.reportDate)) {
    return {
      businessId: business.id,
      businessName: business.name,
      status: "skipped_already_sent",
      recipients: recipients.length,
    };
  }

  if (!recipients.length) {
    const error = "Daily health email is enabled but no active admin recipients are selected.";
    await markFailedAndNotify(business, metrics, [], error);
    return { businessId: business.id, businessName: business.name, status: "failed", recipients: 0, error };
  }

  try {
    const client = await GmailClient.forBusiness(business.id);
    const email = buildHealthEmail(business, metrics, narrative, recipients);
    await client.send({
      to: recipients.map((recipient) => `${recipient.name ?? recipient.email} <${recipient.email}>`).join(", "),
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    await markSentAndNotify(business, metrics, recipients);
    return {
      businessId: business.id,
      businessName: business.name,
      status: "sent",
      recipients: recipients.length,
    };
  } catch (error) {
    const message =
      error instanceof GmailNotConnectedError
        ? "Gmail is not connected for this business."
        : error instanceof GmailReauthRequiredError
          ? "Gmail needs reconnecting for this business."
          : error instanceof Error
            ? error.message
            : "Daily health email failed.";
    await markFailedAndNotify(business, metrics, recipients, message);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        component: "daily_health",
        event: "delivery_failed",
        businessId: business.id,
        error: message,
      }),
    );
    return {
      businessId: business.id,
      businessName: business.name,
      status: "failed",
      recipients: recipients.length,
      error: message,
    };
  }
}

async function loadRecipients(recipientIds: string[]): Promise<Recipient[]> {
  const ids = [...new Set(recipientIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) return [];
  return withSystemContext((tx) =>
    tx
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(and(inArray(users.id, ids), eq(users.role, "admin"), eq(users.active, true)))
      .orderBy(users.name, users.email),
  );
}

async function allActiveAdmins(): Promise<Recipient[]> {
  return withSystemContext((tx) =>
    tx
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.active, true)))
      .orderBy(users.name, users.email),
  );
}

async function alreadyEmailed(businessId: string, reportDate: string): Promise<boolean> {
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .select({ emailedAt: dailyHealthReports.emailedAt })
      .from(dailyHealthReports)
      .where(
        and(
          eq(dailyHealthReports.scope, "business"),
          eq(dailyHealthReports.scopeId, businessId),
          eq(dailyHealthReports.reportDate, reportDate),
        ),
      )
      .limit(1);
    return !!row?.emailedAt;
  });
}

async function markSentAndNotify(business: BusinessSetting, metrics: HealthMetrics, recipients: Recipient[]): Promise<void> {
  const now = new Date();
  await withSystemContext(async (tx) => {
    await tx
      .update(dailyHealthReports)
      .set({
        emailedAt: now,
        emailError: null,
        emailRecipients: recipients.map((recipient) => recipient.email),
        updatedAt: now,
      })
      .where(
        and(
          eq(dailyHealthReports.scope, "business"),
          eq(dailyHealthReports.scopeId, business.id),
          eq(dailyHealthReports.reportDate, metrics.reportDate),
        ),
      );
    await tx.insert(notifications).values(
      recipients.map((recipient) => ({
        businessId: business.id,
        userId: recipient.id,
        type: "daily_health.sent",
        title: `Morning briefing sent for ${business.name}`,
        body: `${summaryLine(metrics)} Open System Health for the full report.`,
        href: "/health",
        metadata: { reportDate: metrics.reportDate, healthy: metrics.healthy },
      })),
    );
  });
}

async function markFailedAndNotify(
  business: BusinessSetting,
  metrics: HealthMetrics,
  recipients: Recipient[],
  error: string,
): Promise<void> {
  const now = new Date();
  const notify = recipients.length ? recipients : await allActiveAdmins();
  await withSystemContext(async (tx) => {
    await tx
      .update(dailyHealthReports)
      .set({
        emailError: error.slice(0, 500),
        emailRecipients: recipients.map((recipient) => recipient.email),
        updatedAt: now,
      })
      .where(
        and(
          eq(dailyHealthReports.scope, "business"),
          eq(dailyHealthReports.scopeId, business.id),
          eq(dailyHealthReports.reportDate, metrics.reportDate),
        ),
      );
    if (notify.length) {
      await tx.insert(notifications).values(
        notify.map((recipient) => ({
          businessId: business.id,
          userId: recipient.id,
          type: "daily_health.failed",
          title: `Morning briefing failed for ${business.name}`,
          body: error,
          href: "/settings?section=notifications",
          metadata: { reportDate: metrics.reportDate, error: error.slice(0, 500) },
        })),
      );
    }
  });
}

function summaryLine(metrics: HealthMetrics): string {
  return metrics.healthy
    ? "Pipeline healthy."
    : `${metrics.pipeline.staleShopCount} stale shops, ${metrics.pipeline.failedEmails} failed emails, ${metrics.operations.overdueNow} overdue orders.`;
}

function buildHealthEmail(
  business: BusinessSetting,
  metrics: HealthMetrics,
  narrative: NarrativeResult | null,
  recipients: Recipient[],
) {
  const subjectStatus = metrics.healthy ? "Healthy" : "Needs attention";
  const subject = `AlphaOS morning briefing: ${business.name} — ${subjectStatus}`;
  const narrativeText = narrative && narrative.status !== "fallback" && narrative.status !== "disabled" ? narrative.text : null;
  const pipelineRows = metrics.links.pipeline;
  const operationRows = metrics.links.operations;

  const text = [
    `AlphaOS morning briefing — ${business.name}`,
    `${metrics.reportDate} · ${subjectStatus}`,
    "",
    "Pipeline integrity",
    ...pipelineRows.map((row) => textMetric(row)),
    "",
    "Operational state",
    ...operationRows.map((row) => textMetric(row)),
    ...(narrativeText ? ["", "Narrative", narrativeText] : []),
    "",
    `System Health: ${appUrl("/health")}`,
    `Sent to: ${recipients.map((recipient) => recipient.email).join(", ")}`,
  ].join("\n");

  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#FBFAF8;color:#16222E;padding:20px">`,
    `<div style="max-width:640px;margin:0 auto;background:#FFFFFF;border:1px solid #E6E2DC;border-radius:12px;overflow:hidden">`,
    `<div style="padding:18px 18px 12px;border-bottom:1px solid #E6E2DC">`,
    `<div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#5C6B7A;letter-spacing:.04em">AlphaOS morning briefing</div>`,
    `<h1 style="font-size:22px;line-height:1.2;margin:8px 0 6px">${escapeHtml(business.name)}</h1>`,
    `<div style="font-size:14px;color:#5C6B7A">${escapeHtml(metrics.reportDate)} · ${escapeHtml(subjectStatus)}</div>`,
    `</div>`,
    htmlSection("Pipeline integrity", pipelineRows),
    htmlSection("Operational state", operationRows),
    narrativeText
      ? [
          `<div style="padding:16px 18px;border-top:1px solid #E6E2DC">`,
          `<h2 style="font-size:15px;margin:0 0 8px">Narrative</h2>`,
          `<p style="font-size:15px;line-height:1.55;margin:0;color:#16222E">${escapeHtml(narrativeText)}</p>`,
          `</div>`,
        ].join("")
      : "",
    `<div style="padding:16px 18px;border-top:1px solid #E6E2DC">`,
    `<a href="${appUrl("/health")}" style="display:inline-block;background:#5B4BC4;color:#FFFFFF;text-decoration:none;border-radius:8px;padding:10px 12px;font-size:14px;font-weight:700">Open System Health</a>`,
    `</div>`,
    `</div>`,
    `</div>`,
  ].join("");

  return { subject, text, html };
}

function textMetric(row: CountLink): string {
  return `- ${row.label}: ${row.count}${row.detail ? ` (${row.detail})` : ""}`;
}

function htmlSection(title: string, rows: CountLink[]) {
  return [
    `<div style="padding:16px 18px;border-top:1px solid #E6E2DC">`,
    `<h2 style="font-size:15px;margin:0 0 10px">${escapeHtml(title)}</h2>`,
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">`,
    ...rows.map((row) => {
      const color = row.tone === "danger" ? "#C6335B" : row.tone === "warning" ? "#8F5B08" : row.tone === "success" ? "#14705A" : "#16222E";
      return [
        `<tr>`,
        `<td style="padding:8px 0;border-top:1px solid #E6E2DC">`,
        `<a href="${appUrl(row.href)}" style="font-size:14px;color:#16222E;text-decoration:none;font-weight:650">${escapeHtml(row.label)}</a>`,
        row.detail ? `<div style="font-size:12px;color:#5C6B7A;margin-top:2px">${escapeHtml(row.detail)}</div>` : "",
        `</td>`,
        `<td align="right" style="padding:8px 0;border-top:1px solid #E6E2DC;color:${color};font-size:20px;font-weight:750">${row.count}</td>`,
        `</tr>`,
      ].join("");
    }),
    `</table>`,
    `</div>`,
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
