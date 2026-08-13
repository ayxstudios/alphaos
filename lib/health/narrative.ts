import { createHash } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import { anthropicFeaturesEnabled } from "@/lib/ai/anthropic";
import { SYSTEM_ACTOR_ID, withUserContext, type RequestUser } from "@/lib/db";
import { dailyHealthReports } from "@/lib/db/schema";
import type { HealthMetrics, HealthScope } from "@/lib/health/daily-report";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const REQUEST_TIMEOUT_MS = 4_500;
const FALLBACK_TEXT = "Narrative unavailable; metrics are current.";

export type NarrativeResult = {
  text: string;
  status: "cached" | "generated" | "fallback" | "disabled";
  generatedAt: string | null;
};

type CachedReport = {
  narrative: string;
  status: string;
  generatedAt: Date;
};

function scopeKey(scope: HealthScope) {
  if (scope.kind === "all") return { scope: "all", scopeId: "all", businessId: null };
  return { scope: "business", scopeId: scope.businessId, businessId: scope.businessId };
}

function metricsHash(metrics: HealthMetrics) {
  return createHash("sha256")
    .update(JSON.stringify(toNarrativePayload(metrics)))
    .digest("hex");
}

function toNarrativePayload(metrics: HealthMetrics) {
  const trailing = metrics.operations.trailing7;
  const previous = metrics.operations.previous7;
  return {
    reportDate: metrics.reportDate,
    scope: metrics.scopeLabel,
    healthy: metrics.healthy,
    pipeline: {
      staleShopCount: metrics.pipeline.staleShopCount,
      staleShops: metrics.pipeline.shops
        .filter((shop) => shop.stale)
        .map((shop) => ({
          business: shop.businessName,
          shop: shop.name,
          platform: shop.platform,
          lastSyncAt: shop.lastSyncAt,
        })),
      queuedEmails: metrics.pipeline.queuedEmails,
      failedEmails: metrics.pipeline.failedEmails,
      staleUnmatchedReplies: metrics.pipeline.staleUnmatchedReplies,
      blockedEarnings: metrics.pipeline.blockedEarnings,
      staleIntake: metrics.pipeline.staleIntake,
      proofNoResponse: metrics.pipeline.proofNoResponse,
    },
    operations: {
      yesterday: metrics.operations.yesterday,
      trailing7: trailing,
      previous7: previous,
      deltasVsPrevious7: {
        ordersIn: trailing.ordersIn - previous.ordersIn,
        delivered: trailing.delivered - previous.delivered,
        onTimeRate: deltaRate(trailing.onTimeRate, previous.onTimeRate),
        qcFailRate: deltaRate(trailing.qcFailRate, previous.qcFailRate),
        revisionRate: deltaRate(trailing.revisionRate, previous.revisionRate),
      },
      overdueNow: metrics.operations.overdueNow,
      worstOverdueHours: metrics.operations.worstOverdueHours,
      topFailedChecklistItem: metrics.operations.topFailedChecklistItem,
      designersOverCapacity: metrics.operations.designersOverCapacity.map((designer) => ({
        name: designer.name,
        business: designer.businessName,
        activeWork: designer.activeWork,
        dailyCapacity: designer.dailyCapacity,
      })),
      designersIdleCount: metrics.operations.designersIdle.length,
      unassigned: metrics.operations.unassigned,
      noEligibleDesignerSample: metrics.operations.noEligibleDesignerSample,
      noEligibleDesignerSampleLimited: metrics.operations.noEligibleDesignerSampleLimited,
    },
  };
}

function deltaRate(current: number | null, previous: number | null) {
  if (current == null || previous == null) return null;
  return Math.round((current - previous) * 10) / 10;
}

function buildPrompt(metrics: HealthMetrics) {
  const payload = toNarrativePayload(metrics);
  return [
    "You are writing AlphaOS's daily operations health briefing.",
    "Use only the aggregate JSON below. It intentionally contains no customer names, emails, order contents, or order-level records.",
    "Write like a competent operations manager briefing the owner.",
    "Rank by urgency, not by category. Keep it to three to six sentences.",
    "Mention what changed versus the previous 7-day window when the aggregate deltas make that meaningful.",
    "If every metric is healthy, write one plain sentence saying nothing needs attention today.",
    "Do not invent concern when the healthy field is true.",
    "Do not include bullet points, headings, or markdown.",
    "",
    JSON.stringify(payload),
  ].join("\n");
}

async function callAnthropic(prompt: string, signal: AbortSignal) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 220,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic narrative request failed: ${res.status} ${text.slice(0, 180)}`);
  }
  const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
  const text = json.content?.find((part) => part.type === "text")?.text?.trim();
  if (!text) throw new Error("Anthropic narrative response had no text");
  return text;
}

async function loadTodaysCache(user: RequestUser, metrics: HealthMetrics): Promise<CachedReport | null> {
  const key = scopeKey(metrics.scope);
  return withUserContext(user, async (tx) => {
    const [row] = await tx
      .select({
        narrative: dailyHealthReports.narrative,
        status: dailyHealthReports.status,
        generatedAt: dailyHealthReports.generatedAt,
      })
      .from(dailyHealthReports)
      .where(
        and(
          eq(dailyHealthReports.scope, key.scope),
          eq(dailyHealthReports.scopeId, key.scopeId),
          eq(dailyHealthReports.reportDate, metrics.reportDate),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

async function loadPreviousCache(user: RequestUser, scope: HealthScope): Promise<CachedReport | null> {
  const key = scopeKey(scope);
  return withUserContext(user, async (tx) => {
    const [row] = await tx
      .select({
        narrative: dailyHealthReports.narrative,
        status: dailyHealthReports.status,
        generatedAt: dailyHealthReports.generatedAt,
      })
      .from(dailyHealthReports)
      .where(and(eq(dailyHealthReports.scope, key.scope), eq(dailyHealthReports.scopeId, key.scopeId)))
      .orderBy(desc(dailyHealthReports.reportDate))
      .limit(1);
    return row ?? null;
  });
}

async function saveNarrative(
  user: RequestUser,
  metrics: HealthMetrics,
  narrative: string,
  status: "ok" | "fallback" | "disabled",
  error?: string,
) {
  const key = scopeKey(metrics.scope);
  const now = new Date();
  await withUserContext(user, async (tx) => {
    await tx
      .insert(dailyHealthReports)
      .values({
        scope: key.scope,
        scopeId: key.scopeId,
        businessId: key.businessId,
        reportDate: metrics.reportDate,
        metricsHash: metricsHash(metrics),
        narrative,
        status,
        error: error ? error.slice(0, 500) : null,
        generatedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [dailyHealthReports.scope, dailyHealthReports.scopeId, dailyHealthReports.reportDate],
        set: {
          metricsHash: metricsHash(metrics),
          narrative,
          status,
          error: error ? error.slice(0, 500) : null,
          generatedAt: now,
          updatedAt: now,
        },
      });
  });
}

export async function loadDailyNarrative(user: RequestUser, metrics: HealthMetrics): Promise<NarrativeResult> {
  if (!anthropicFeaturesEnabled()) {
    return { text: "", status: "disabled", generatedAt: null };
  }

  const today = await loadTodaysCache(user, metrics);
  if (today && today.status !== "disabled") {
    return {
      text: today.narrative,
      status: today.narrative === FALLBACK_TEXT ? "fallback" : "cached",
      generatedAt: today.generatedAt.toISOString(),
    };
  }

  if (metrics.healthy) {
    const text = `Nothing needs attention today for ${metrics.scopeLabel}; the pipeline is healthy and the current workload is moving normally.`;
    await saveNarrative(user, metrics, text, "ok");
    return { text, status: "generated", generatedAt: new Date().toISOString() };
  }

  const previous = await loadPreviousCache(user, metrics.scope);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const text = await callAnthropic(buildPrompt(metrics), controller.signal);
    await saveNarrative(user, metrics, text, "ok");
    return { text, status: "generated", generatedAt: new Date().toISOString() };
  } catch (error) {
    const previousUsable = previous && previous.status !== "disabled" && previous.narrative ? previous : null;
    const text = previousUsable?.narrative ?? FALLBACK_TEXT;
    await saveNarrative(
      user,
      metrics,
      text,
      "fallback",
      error instanceof Error ? error.message : "Unknown narrative error",
    );
    return {
      text,
      status: "fallback",
      generatedAt: previousUsable?.generatedAt.toISOString() ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadDailyNarrativeForSystem(metrics: HealthMetrics): Promise<NarrativeResult> {
  return loadDailyNarrative({ id: SYSTEM_ACTOR_ID, role: "admin" }, metrics);
}

export async function ensureDailyHealthReportForSystem(metrics: HealthMetrics): Promise<void> {
  await saveNarrative({ id: SYSTEM_ACTOR_ID, role: "admin" }, metrics, "", "disabled");
}
