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
  /** Unfinished orders tagged with this style (deleting it blocks their pay). */
  openOrders: number;
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
        <p className="text-sm font-semibold text-ink">Add a style</p>
        <p className="mt-0.5 text-sm text-slate">A name and a rate per figure, e.g. Watercolor at 5.00.</p>
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
        <div className="rounded-card bg-surface p-8 shadow-card text-center">
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
  const [deleteOpen, setDeleteOpen] = useState(false);

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
    // A refused name or rate goes back to the saved value, so the field never
    // shows something that did not save.
    onRun(async () => {
      const res = await renameStyle(style.id, n);
      if (!res.ok) setNameDraft(style.name);
      return res;
    }, "Style renamed");
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
    onRun(async () => {
      const res = await setStyleRate(style.id, r);
      if (!res.ok) setRateDraft(style.perFigureRate ?? "");
      return res;
    }, "Rate saved");
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
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
        </div>
      </div>

      {/* Title rules */}
      <div className="mt-4">
        <p className="text-xs font-medium text-ink">Auto-assign when the product title contains</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {style.titleMatches.map((m) => (
            <span key={m} className="inline-flex items-center gap-1 rounded-input bg-pigment-soft px-2 py-0.5 text-xs font-medium text-pigment">
              {m}
              <button type="button" onClick={() => removeMatch(m)} aria-label={`Remove ${m}`} className="-my-3 -mr-3 inline-flex size-11 items-center justify-center hover:text-ink sm:m-0 sm:size-auto">
                <XCircle size={13} />
              </button>
            </span>
          ))}
          {style.titleMatches.length === 0 && !style.isDefault && (
            <span className="text-xs text-slate">No rules yet, so nothing auto-assigns here.</span>
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
            placeholder={`A word, e.g. ${style.name.charAt(0).toUpperCase()}${style.name.slice(1)}`}
            aria-label="Add a title rule"
            className="h-9 max-w-xs"
          />
          <Button type="button" variant="secondary" size="sm" onClick={addMatch} disabled={!matchInput.trim()}>
            Add rule
          </Button>
        </div>
      </div>

      {/* Default toggle + assigned summary */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-3">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink sm:min-h-0 sm:gap-2">
          <input
            type="checkbox"
            checked={style.isDefault}
            disabled={pending}
            onChange={(e) => onRun(() => setStyleDefault(style.id, e.target.checked))}
            className="size-5 shrink-0 rounded border-line accent-pigment sm:size-4"
          />
          Default style when no rule matches
        </label>
        <p className="text-xs text-slate">
          {assignedNames.length ? `Designers: ${assignedNames.join(", ")}` : "No designers assigned yet"}
        </p>
      </div>

      {/* Deleting is not undone, so say what it does to open orders first. */}
      <Drawer open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete style">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink">
            Delete the <span className="font-semibold">{style.name}</span> style?
          </p>
          <p className="text-sm text-slate">
            {style.openOrders > 0
              ? `${style.openOrders} unfinished order${style.openOrders === 1 ? " uses" : "s use"} it. Their designer${style.openOrders === 1 ? "" : "s"} cannot be paid for ${style.openOrders === 1 ? "it" : "them"} until you give ${style.openOrders === 1 ? "it" : "them"} another style.`
              : "No unfinished orders use it."}{" "}
            Designers keep their other styles.
          </p>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" className="min-h-11 sm:min-h-0" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              className="min-h-11 sm:min-h-0"
              onClick={() => {
                setDeleteOpen(false);
                onRun(() => deleteStyle(style.id), "Style deleted");
              }}
            >
              Delete style
            </Button>
          </div>
        </div>
      </Drawer>

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
            <label key={d.id} className="flex min-h-11 cursor-pointer items-center gap-3 py-2.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={selected.has(d.id)}
                onChange={() => toggle(d.id)}
                className="size-5 shrink-0 rounded border-line accent-pigment sm:size-4"
              />
              {d.name}
            </label>
          ))}
        </div>
      )}
      {/* Same button order as every other drawer: Cancel, then the action. */}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" className="min-h-11 sm:min-h-0" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          className="min-h-11 sm:min-h-0"
          onClick={() => {
            onRun(() => setStyleDesigners(style.id, [...selected]), "Designers updated");
            onClose();
          }}
        >
          Save
        </Button>
      </div>
    </Drawer>
  );
}
