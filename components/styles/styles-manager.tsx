"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Drawer, Input, useToast } from "@/components/ui";
import { Brush, Plus, XCircle } from "@/components/ui/icons";
import {
  createStyle,
  renameStyle,
  setStyleRate,
  setStyleTitleMatches,
  setStyleDefault,
  deleteStyle,
  setStyleDesigners,
  type ActionResult,
} from "@/app/(app)/styles/actions";

export type StyleVM = {
  id: string;
  name: string;
  perFigureRate: string | null;
  titleMatches: string[];
  isDefault: boolean;
  designerIds: string[];
};

export type DesignerOption = { id: string; name: string; styles: string[] };

export function StylesManager({
  styles,
  designers,
}: {
  styles: StyleVM[];
  designers: { id: string; name: string; styles: string[] }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [pending, start] = useTransition();

  function run(action: () => Promise<ActionResult>, ok?: string) {
    start(async () => {
      const res = await action();
      if (!res.ok) {
        toast({ variant: "danger", title: "Didn't save", description: res.message });
        return;
      }
      if (ok) toast({ variant: "success", title: ok });
      router.refresh();
    });
  }

  function add() {
    const n = name.trim();
    const r = rate.trim();
    if (!n || !r) return;
    run(async () => {
      const res = await createStyle(n, r);
      if (res.ok) {
        setName("");
        setRate("");
      }
      return res;
    }, "Style added");
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Add a new style */}
      <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
        <p className="text-sm font-semibold text-ink">Add a new portrait style</p>
        <p className="mt-0.5 text-sm text-slate">
          Give it a name (e.g. Cartoon Disney, Watercolor). Then set its title rules and designers below.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Style name"
            className="sm:max-w-xs"
            aria-label="New style name"
          />
          <Input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Rate per figure"
            inputMode="decimal"
            className="sm:max-w-40"
            aria-label="New style rate per figure"
          />
          <Button type="button" onClick={add} loading={pending} disabled={!name.trim() || !rate.trim()} className="w-fit">
            <Plus size={16} /> Add style
          </Button>
        </div>
      </div>

      {styles.length === 0 ? (
        <div className="rounded-card border border-dashed border-line bg-surface p-8 text-center">
          <Brush className="mx-auto text-slate" size={22} />
          <p className="mt-2 text-sm font-medium text-ink">No styles yet</p>
          <p className="text-sm text-slate">Add your first portrait style above.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {styles.map((style) => (
            <StyleCard key={style.id} style={style} designers={designers} onRun={run} pending={pending} />
          ))}
        </div>
      )}
    </div>
  );
}

function StyleCard({
  style,
  designers,
  onRun,
  pending,
}: {
  style: StyleVM;
  designers: { id: string; name: string; styles: string[] }[];
  onRun: (action: () => Promise<ActionResult>, ok?: string) => void;
  pending: boolean;
}) {
  const [nameDraft, setNameDraft] = useState(style.name);
  const [rateDraft, setRateDraft] = useState(style.perFigureRate ?? "");
  const [matchInput, setMatchInput] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);

  const assignedNames = designers
    .filter((d) => style.designerIds.includes(d.id))
    .map((d) => d.name);

  useEffect(() => {
    setNameDraft(style.name);
    setRateDraft(style.perFigureRate ?? "");
  }, [style.name, style.perFigureRate]);

  function saveName() {
    const n = nameDraft.trim();
    if (!n || n === style.name) {
      setNameDraft(style.name);
      return;
    }
    onRun(() => renameStyle(style.id, n), "Style renamed");
  }

  function addMatch() {
    const m = matchInput.trim();
    if (!m) return;
    if (style.titleMatches.some((x) => x.toLowerCase() === m.toLowerCase())) {
      setMatchInput("");
      return;
    }
    setMatchInput("");
    onRun(() => setStyleTitleMatches(style.id, [...style.titleMatches, m]));
  }

  function saveRate() {
    const r = rateDraft.trim();
    if (!r || r === (style.perFigureRate ?? "")) {
      setRateDraft(style.perFigureRate ?? "");
      return;
    }
    onRun(() => setStyleRate(style.id, r), "Rate saved");
  }

  function removeMatch(m: string) {
    onRun(() => setStyleTitleMatches(style.id, style.titleMatches.filter((x) => x !== m)));
  }

  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Style name"
          className="h-9 max-w-xs font-semibold"
        />
        {style.isDefault && <Badge variant="info" dot>Default</Badge>}
        {!style.perFigureRate && <Badge variant="warning">Rate missing</Badge>}
        <label className="flex items-center gap-2 text-xs font-medium text-slate">
          Per figure
          <Input
            value={rateDraft}
            onChange={(e) => setRateDraft(e.target.value)}
            onBlur={saveRate}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            inputMode="decimal"
            aria-label={`${style.name} rate per figure`}
            className="h-9 w-28"
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setAssignOpen(true)}>
            Designers · {style.designerIds.length}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (confirm(`Delete the "${style.name}" style? Designers will keep their other styles.`)) {
                onRun(() => deleteStyle(style.id), "Style deleted");
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      {/* Title rules */}
      <div className="mt-4">
        <p className="text-xs font-medium text-ink">Auto-assign when the product title contains</p>
        <p className="text-xs text-slate">Case-insensitive. Any one match tags the order with this style.</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {style.titleMatches.map((m) => (
            <span key={m} className="inline-flex items-center gap-1 rounded-input bg-pigment-soft px-2 py-0.5 text-xs font-medium text-pigment">
              {m}
              <button type="button" onClick={() => removeMatch(m)} aria-label={`Remove ${m}`} className="hover:text-ink">
                <XCircle size={13} />
              </button>
            </span>
          ))}
          {style.titleMatches.length === 0 && !style.isDefault && (
            <span className="text-xs text-slate">No rules yet — this style won&apos;t auto-assign until you add one or make it the default.</span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={matchInput}
            onChange={(e) => setMatchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addMatch();
              }
            }}
            placeholder="e.g. Watercolor"
            aria-label="Add a title rule"
            className="h-9 max-w-xs"
          />
          <Button type="button" variant="secondary" size="sm" onClick={addMatch} disabled={!matchInput.trim()}>
            Add rule
          </Button>
        </div>
      </div>

      {/* Default toggle + assigned summary */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <label className="inline-flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={style.isDefault}
            disabled={pending}
            onChange={(e) => onRun(() => setStyleDefault(style.id, e.target.checked))}
            className="size-4 rounded border-line text-pigment focus:ring-pigment"
          />
          Use as the default style (when no rule matches)
        </label>
        <p className="text-xs text-slate">
          {assignedNames.length ? `Designers: ${assignedNames.join(", ")}` : "No designers assigned yet"}
        </p>
      </div>

      <AssignDesignersDrawer
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        style={style}
        designers={designers}
        onRun={onRun}
      />
    </div>
  );
}

function AssignDesignersDrawer({
  open,
  onClose,
  style,
  designers,
  onRun,
}: {
  open: boolean;
  onClose: () => void;
  style: StyleVM;
  designers: { id: string; name: string }[];
  onRun: (action: () => Promise<ActionResult>, ok?: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(style.designerIds));

  // Reset local selection whenever the drawer opens for a (possibly) new style.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (open && seededFor !== style.id) {
    setSelected(new Set(style.designerIds));
    setSeededFor(style.id);
  }
  if (!open && seededFor !== null) setSeededFor(null);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Drawer open={open} onClose={onClose} title={`Designers for ${style.name}`}>
      <p className="text-sm text-slate">Tick the designers who do this style. They&apos;ll be eligible when an order is tagged {style.name}.</p>
      {designers.length === 0 ? (
        <p className="mt-4 text-sm text-slate">No designers in this workspace yet.</p>
      ) : (
        <div className="mt-3 flex flex-col divide-y divide-line">
          {designers.map((d) => (
            <label key={d.id} className="flex cursor-pointer items-center gap-3 py-2.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={selected.has(d.id)}
                onChange={() => toggle(d.id)}
                className="size-4 rounded border-line text-pigment focus:ring-pigment"
              />
              {d.name}
            </label>
          ))}
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        <Button
          type="button"
          onClick={() => {
            onRun(() => setStyleDesigners(style.id, [...selected]), "Designers updated");
            onClose();
          }}
        >
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Drawer>
  );
}
