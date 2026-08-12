"use client";

import { useState, useTransition } from "react";

import { runNotificationDryRun } from "@/app/(app)/settings/actions";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, useToast } from "@/components/ui";
import type { NotificationSweepResult } from "@/lib/notifications/sla-sweep";

function label(type: string): string {
  return type.replaceAll("_", " ").replaceAll(".", " / ");
}

function n(value: number): string {
  return new Intl.NumberFormat("en").format(value);
}

export function NotificationDryRunPanel() {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [report, setReport] = useState<NotificationSweepResult | null>(null);

  function run() {
    startTransition(async () => {
      const result = await runNotificationDryRun();
      if (!result.ok) {
        toast({ variant: "danger", title: "Dry-run failed", description: result.message });
        return;
      }
      setReport(result.report);
      toast({
        variant: result.report.wouldFire > 0 ? "warning" : "success",
        title: "Dry-run complete",
        description: `${n(result.report.wouldFire)} fires would create ${n(result.report.wouldCreateNotifications)} notifications.`,
      });
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>SLA sweep dry-run</CardTitle>
          </div>
          <Badge variant="warning" dot>
            Dry-run
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={run} loading={pending}>
            Run dry-run
          </Button>
        </div>

        {report && (
          <div className="mt-4 flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Metric label="Candidates" value={report.candidates} />
              <Metric label="Would fire" value={report.wouldFire} tone={report.wouldFire ? "warning" : "success"} />
              <Metric label="Would notify" value={report.wouldCreateNotifications} />
              <Metric label="Already fired" value={report.skippedDuplicate} />
              <Metric label="No recipients" value={report.noRecipients} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <SummaryTable
                title="By alert type"
                columns={["Alert", "Would fire", "Would notify", "Candidates"]}
                rows={report.byType.map((row) => [
                  label(row.alertType),
                  n(row.wouldFire),
                  n(row.wouldCreateNotifications),
                  n(row.candidates),
                ])}
              />
              <SummaryTable
                title="By business"
                columns={["Business", "Would fire", "Would notify", "Candidates"]}
                rows={report.byBusiness.map((row) => [
                  row.businessName,
                  n(row.wouldFire),
                  n(row.wouldCreateNotifications),
                  n(row.candidates),
                ])}
              />
            </div>

            <SummaryTable
              title="Top recipients"
              columns={["Recipient", "Role", "Would receive"]}
              rows={report.topRecipients.map((row) => [
                row.name ? `${row.name} · ${row.email}` : row.email,
                row.role,
                n(row.wouldReceive),
              ])}
              empty="No recipient fan-out would be created."
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <div className="rounded-input border border-line bg-canvas px-3 py-2">
      <div className="text-xs font-medium uppercase tracking-wide text-slate">{label}</div>
      <div className={tone === "warning" ? "mt-1 text-xl font-semibold text-amber" : tone === "success" ? "mt-1 text-xl font-semibold text-sage" : "mt-1 text-xl font-semibold text-ink"}>
        {n(value)}
      </div>
    </div>
  );
}

function SummaryTable({
  title,
  columns,
  rows,
  empty = "Nothing to show.",
}: {
  title: string;
  columns: string[];
  rows: string[][];
  empty?: string;
}) {
  return (
    <div className="overflow-hidden rounded-input border border-line">
      <div className="border-b border-line bg-canvas px-3 py-2 text-sm font-semibold text-ink">{title}</div>
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-slate">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <thead className="bg-canvas text-xs font-semibold uppercase tracking-wide text-slate">
              <tr>
                {columns.map((column) => (
                  <th key={column} className="px-3 py-2">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row, idx) => (
                <tr key={idx}>
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="px-3 py-2 text-ink">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
