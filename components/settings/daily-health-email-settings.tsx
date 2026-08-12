"use client";

import { useMemo, useState, useTransition } from "react";

import { saveDailyHealthEmailSettings } from "@/app/(app)/settings/actions";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, useToast } from "@/components/ui";

export type DailyHealthAdminVM = {
  id: string;
  name: string | null;
  email: string;
};

export type DailyHealthEmailSettingsVM = {
  businessId: string;
  businessName: string;
  enabled: boolean;
  recipientIds: string[];
};

export function DailyHealthEmailSettingsPanel({
  settings,
  admins,
}: {
  settings: DailyHealthEmailSettingsVM;
  admins: DailyHealthAdminVM[];
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [selected, setSelected] = useState(() => new Set(settings.recipientIds));
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const selectedCount = selected.size;
  const selectedIds = useMemo(() => [...selected], [selected]);

  function toggleRecipient(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function save() {
    startTransition(async () => {
      const result = await saveDailyHealthEmailSettings({
        businessId: settings.businessId,
        enabled,
        recipientIds: selectedIds,
      });
      toast({
        variant: result.ok ? "success" : "danger",
        title: result.ok ? "Morning briefing saved" : "Could not save briefing",
        description: result.message,
      });
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Daily health email</CardTitle>
            <CardDescription>
              Sends the selected business&apos;s morning briefing to chosen admins at 7am Melbourne time.
            </CardDescription>
          </div>
          <Badge variant={enabled ? "success" : "neutral"} dot={enabled}>
            {enabled ? "On" : "Off"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <label className="flex items-start gap-3 rounded-input border border-line bg-canvas p-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-pigment"
            checked={enabled}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />
          <span>
            <span className="block text-sm font-semibold text-ink">Send morning briefing for {settings.businessName}</span>
            <span className="mt-1 block text-sm text-slate">
              Default is off. Gmail must be connected for this business before the cron can send.
            </span>
          </span>
        </label>

        <div className="mt-4">
          <p className="text-sm font-semibold text-ink">Recipients</p>
          <p className="mt-1 text-sm text-slate">Only active admin accounts can receive the report.</p>
          {admins.length === 0 ? (
            <p className="mt-3 rounded-input border border-amber/25 bg-amber/10 p-3 text-sm text-amber">
              No active admins found.
            </p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {admins.map((admin) => (
                <label key={admin.id} className="flex items-start gap-3 rounded-input border border-line p-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-pigment"
                    checked={selected.has(admin.id)}
                    onChange={(event) => toggleRecipient(admin.id, event.currentTarget.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{admin.name ?? admin.email}</span>
                    <span className="block truncate text-xs text-slate">{admin.email}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={save} loading={pending}>
            Save briefing settings
          </Button>
          <span className="text-xs text-slate">
            {selectedCount} recipient{selectedCount === 1 ? "" : "s"} selected
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
