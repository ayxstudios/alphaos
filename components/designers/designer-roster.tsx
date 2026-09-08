"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";

import { cn } from "@/lib/utils";
import { Avatar, Button, Input, Select, useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { ChevronDown, Check } from "@/components/ui/icons";
import {
  moveDesigner,
  setDailyLimit,
  setMaxActiveOrders,
  setStyles,
  setContact,
  type ContactPatch,
} from "@/app/(app)/designers/actions";
import type { DesignerRow } from "@/lib/designers/roster";
import { TIMEZONE_OPTIONS } from "@/lib/designers/quiet-hours";

type ActionResult = { ok: boolean; message?: string };

/**
 * Ranked designer roster. Every edit is OPTIMISTIC — the UI updates instantly
 * and the server action persists in the background (no blocking refresh), so it
 * feels immediate even with a slow round-trip. On failure we revert to the last
 * server state and toast.
 */
export function DesignerRoster({
  designers,
  styleOptions,
  canEdit,
}: {
  designers: DesignerRow[];
  styleOptions: string[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const [list, setList] = useState(designers);
  const [, startBg] = useTransition();

  // Re-sync to the server's ordering/values on a genuine data refresh.
  useEffect(() => setList(designers), [designers]);

  function persist(optimistic: DesignerRow[], action: () => Promise<ActionResult>) {
    setList(optimistic);
    startBg(async () => {
      const res = await action();
      if (!res.ok) {
        setList(designers);
        toast({ variant: "danger", title: "Update failed", description: res.message });
      }
    });
  }

  function reorder(userId: string, dir: "up" | "down") {
    const idx = list.findIndex((d) => d.userId === userId);
    const swap = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || swap < 0 || swap >= list.length) return;
    const next = [...list];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    persist(next, () => moveDesigner(userId, dir));
  }

  function patch(userId: string, patchRow: Partial<DesignerRow>, action: () => Promise<ActionResult>) {
    persist(
      list.map((d) => (d.userId === userId ? { ...d, ...patchRow } : d)),
      action,
    );
  }

  return (
    <div className="rounded-card border border-line bg-surface shadow-sm">
      <div className="hidden grid-cols-[5rem_1fr_1.6fr_7rem_11rem] gap-3 border-b border-line px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate lg:grid">
        <span>Rank</span>
        <span>Designer</span>
        <span>Styles</span>
        <span>Daily limit</span>
        <span>Assigned today</span>
      </div>
      <ul className="divide-y divide-line">
        {list.map((d, i) => (
          <Row
            key={d.userId}
            d={d}
            position={i + 1}
            first={i === 0}
            last={i === list.length - 1}
            canEdit={canEdit}
            styleOptions={styleOptions}
            onReorder={reorder}
            onMaxActiveOrders={(n) =>
              patch(d.userId, { maxActiveOrders: n }, () => setMaxActiveOrders(d.userId, n))
            }
            onContact={(c) =>
              patch(
                d.userId,
                {
                  phone: c.phone || null,
                  preferredChannel: c.preferredChannel,
                  timezone: c.timezone || null,
                  quietStart: c.quietStart || null,
                  quietEnd: c.quietEnd || null,
                },
                () => setContact(d.userId, c),
              )
            }
            onLimit={(n) => patch(d.userId, { dailyCapacity: n }, () => setDailyLimit(d.userId, n))}
            onStyles={(styles) => patch(d.userId, { styles }, () => setStyles(d.userId, styles))}
          />
        ))}
      </ul>
    </div>
  );
}

function Row({
  d,
  position,
  first,
  last,
  canEdit,
  styleOptions,
  onReorder,
  onLimit,
  onStyles,
  onMaxActiveOrders,
  onContact,
}: {
  d: DesignerRow;
  position: number;
  first: boolean;
  last: boolean;
  canEdit: boolean;
  styleOptions: string[];
  onReorder: (userId: string, dir: "up" | "down") => void;
  onLimit: (n: number) => void;
  onStyles: (styles: string[]) => void;
  onMaxActiveOrders: (n: number) => void;
  onContact: (patch: ContactPatch) => void;
}) {
  const [limit, setLimit] = useState(String(d.dailyCapacity));
  useEffect(() => setLimit(String(d.dailyCapacity)), [d.dailyCapacity]);
  const [expanded, setExpanded] = useState(false);

  function commitLimit() {
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n === d.dailyCapacity) {
      setLimit(String(d.dailyCapacity));
      return;
    }
    onLimit(Math.max(0, n));
  }

  const atLimit = d.dailyCapacity > 0 && d.assignedToday >= d.dailyCapacity;
  const pct = d.dailyCapacity > 0 ? Math.min(100, (d.assignedToday / d.dailyCapacity) * 100) : 0;
  const contactSet = !!(d.phone || d.timezone || d.quietStart);

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[5rem_1fr_1.6fr_7rem_11rem] lg:items-center">
      {/* Rank + reorder */}
      <div className="flex items-center gap-2">
        <span className="w-6 text-sm font-semibold tabular-nums text-ink">{position}</span>
        {canEdit && (
          <div className="flex flex-col">
            <button
              type="button"
              aria-label="Move up"
              disabled={first}
              onClick={() => onReorder(d.userId, "up")}
              className={cn(
                "flex size-10 items-center justify-center rounded text-slate hover:bg-canvas hover:text-ink disabled:opacity-30",
                focusRing,
              )}
            >
              <ChevronDown size={14} className="rotate-180" />
            </button>
            <button
              type="button"
              aria-label="Move down"
              disabled={last}
              onClick={() => onReorder(d.userId, "down")}
              className={cn(
                "flex size-10 items-center justify-center rounded text-slate hover:bg-canvas hover:text-ink disabled:opacity-30",
                focusRing,
              )}
            >
              <ChevronDown size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Designer */}
      <Link
        href={`/designers/${d.userId}`}
        className={cn("flex min-w-0 items-center gap-2.5 rounded-input", focusRing)}
      >
        <Avatar name={d.name} size="sm" />
        <span className="truncate text-sm font-medium text-ink hover:text-pigment">{d.name}</span>
      </Link>

      {/* Styles */}
      <div>
        {canEdit ? (
          <StyleSelect selected={d.styles} options={styleOptions} onChange={onStyles} />
        ) : d.styles.length ? (
          <div className="flex flex-wrap gap-1">
            {d.styles.map((s) => (
              <span key={s} className="rounded bg-sage/10 px-1.5 py-0.5 text-xs text-sage">
                {s}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-slate">Any style</span>
        )}
      </div>

      {/* Daily limit */}
      <div>
        {canEdit ? (
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            onBlur={commitLimit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className={cn(
              "h-9 w-20 rounded-input border border-line bg-surface px-2.5 text-sm tabular-nums text-ink",
              focusRing,
            )}
          />
        ) : (
          <span className="text-sm tabular-nums text-ink">{d.dailyCapacity}</span>
        )}
      </div>

      {/* Assigned today */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className={cn("font-medium tabular-nums", atLimit ? "text-rose" : "text-ink")}>
            {d.assignedToday} / {d.dailyCapacity}
          </span>
          <span className="text-slate">{d.wipCount} in flight</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas">
          <div
            className={cn("h-full rounded-full", atLimit ? "bg-rose" : "bg-pigment")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex min-h-10 w-full items-center justify-between gap-2 rounded-input border border-line bg-canvas/60 px-3 py-2 text-xs font-medium text-slate hover:text-ink",
          focusRing,
        )}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1.5">
          Contact &amp; limits
          {contactSet && <span className="size-1.5 rounded-full bg-sage" aria-hidden />}
        </span>
        <ChevronDown size={14} className={cn("transition-transform motion-hover", expanded && "rotate-180")} />
      </button>

      {expanded && (
        <ContactPanel designer={d} canEdit={canEdit} onSave={onContact} onMaxActiveOrders={onMaxActiveOrders} />
      )}
    </li>
  );
}

/**
 * What Alpha needs to message this designer directly — phone, channel,
 * timezone, quiet hours — plus the max-active-orders cap on the auto-assigner.
 * Read-only for anyone who isn't admin/va (mirrors what the designer sees on
 * their own /me page).
 */
function ContactPanel({
  designer: d,
  canEdit,
  onSave,
  onMaxActiveOrders,
}: {
  designer: DesignerRow;
  canEdit: boolean;
  onSave: (patch: ContactPatch) => void;
  onMaxActiveOrders: (n: number) => void;
}) {
  const [phone, setPhone] = useState(d.phone ?? "");
  const [channel, setChannel] = useState(d.preferredChannel);
  const [timezone, setTimezone] = useState(d.timezone ?? "");
  const [quietStart, setQuietStart] = useState(d.quietStart ?? "");
  const [quietEnd, setQuietEnd] = useState(d.quietEnd ?? "");
  const [maxActive, setMaxActive] = useState(String(d.maxActiveOrders));

  useEffect(() => {
    setPhone(d.phone ?? "");
    setChannel(d.preferredChannel);
    setTimezone(d.timezone ?? "");
    setQuietStart(d.quietStart ?? "");
    setQuietEnd(d.quietEnd ?? "");
    setMaxActive(String(d.maxActiveOrders));
  }, [d.phone, d.preferredChannel, d.timezone, d.quietStart, d.quietEnd, d.maxActiveOrders]);

  const dirty =
    phone !== (d.phone ?? "") ||
    channel !== d.preferredChannel ||
    timezone !== (d.timezone ?? "") ||
    quietStart !== (d.quietStart ?? "") ||
    quietEnd !== (d.quietEnd ?? "");

  function save() {
    onSave({ phone: phone.trim(), preferredChannel: channel, timezone: timezone.trim(), quietStart, quietEnd });
  }

  function commitMaxActive() {
    const n = parseInt(maxActive, 10);
    if (!Number.isFinite(n) || n === d.maxActiveOrders) {
      setMaxActive(String(d.maxActiveOrders));
      return;
    }
    onMaxActiveOrders(Math.max(0, n));
  }

  if (!canEdit) {
    return (
      <div className="grid grid-cols-2 gap-3 rounded-input border border-line bg-canvas/40 p-3 text-xs sm:grid-cols-4">
        <Field label="Phone" value={d.phone ?? "Not set"} />
        <Field label="Channel" value={d.preferredChannel === "telegram" ? "Telegram" : "WhatsApp"} />
        <Field label="Timezone" value={d.timezone ?? "Not set"} />
        <Field
          label="Quiet hours"
          value={d.quietStart && d.quietEnd ? `${d.quietStart} to ${d.quietEnd}` : "None"}
        />
        <Field label="Max active orders" value={d.maxActiveOrders > 0 ? String(d.maxActiveOrders) : "No cap"} />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-input border border-line bg-canvas/40 p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          label="Phone"
          placeholder="+62 812 3456 7890"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Select label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as "whatsapp" | "telegram")}>
          <option value="whatsapp">WhatsApp</option>
          <option value="telegram">Telegram</option>
        </Select>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-slate">Timezone</label>
          <input
            list="designer-timezones"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Asia/Jakarta"
            className={cn(
              "h-10 rounded-input border border-line bg-surface px-3 text-sm text-ink",
              focusRing,
            )}
          />
          <datalist id="designer-timezones">
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-slate">Max active orders</label>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={maxActive}
            onChange={(e) => setMaxActive(e.target.value)}
            onBlur={commitMaxActive}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className={cn(
              "h-10 rounded-input border border-line bg-surface px-3 text-sm tabular-nums text-ink",
              focusRing,
            )}
          />
          <p className="text-xs text-slate">0 = no cap on work in flight</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:max-w-xs">
        <Input
          label="Quiet hours start"
          type="time"
          value={quietStart}
          onChange={(e) => setQuietStart(e.target.value)}
        />
        <Input label="Quiet hours end" type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
      </div>
      <p className="text-xs text-slate">
        A brief, nudge or QC message that would land inside quiet hours is held until the window ends.
        Escalations (reassignment) are never held.
      </p>
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={!dirty} onClick={save}>
          Save contact
        </Button>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</p>
      <p className="text-ink">{value}</p>
    </div>
  );
}

/**
 * Add/remove designer styles — constrained to the shop-offered catalog. You can
 * only pick styles some shop actually sells; a designer can hold several.
 */
function StyleSelect({
  selected,
  options,
  onChange,
}: {
  selected: string[];
  options: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selectedLower = new Set(selected.map((s) => s.toLowerCase()));
  function toggle(opt: string) {
    const l = opt.toLowerCase();
    onChange(
      selectedLower.has(l) ? selected.filter((s) => s.toLowerCase() !== l) : [...selected, opt],
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex min-h-9 w-full items-center gap-1 rounded-input border border-line bg-surface px-2 py-1 text-left",
          focusRing,
        )}
      >
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {selected.length ? (
            selected.map((s) => (
              <span key={s} className="rounded bg-sage/10 px-1.5 py-0.5 text-xs text-sage">
                {s}
              </span>
            ))
          ) : (
            <span className="text-sm text-slate">Any style</span>
          )}
        </span>
        <ChevronDown size={15} className="shrink-0 text-slate" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full min-w-52 overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-lg">
          {options.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate">
              No styles defined. Add them per shop in Settings → Styles.
            </p>
          ) : (
            options.map((opt) => {
              const on = selectedLower.has(opt.toLowerCase());
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggle(opt)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-sm hover:bg-canvas",
                    focusRing,
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded border",
                      on ? "border-pigment bg-pigment text-surface" : "border-line",
                    )}
                  >
                    {on && <Check size={12} />}
                  </span>
                  <span className={cn(on ? "text-ink" : "text-slate")}>{opt}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
