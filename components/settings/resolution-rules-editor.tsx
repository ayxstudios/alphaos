"use client";

import { useState, useTransition } from "react";

import { Button, Input, Select, Textarea } from "@/components/ui";
import { Plus, XCircle } from "@/components/ui/icons";
import {
  saveShopResolutionRules,
  reresolveShopOrders,
} from "@/app/(app)/settings/actions";
import type { FigureRule, StyleRule } from "@/lib/integrations/figures";
import type { ReresolveSummary } from "@/lib/orders/resolution";

type FigureDraft = { match: string; type: "integer" | "map"; mapText: string };
type StyleDraft = { match: string };

function mapToText(map?: Record<string, number>): string {
  if (!map) return "";
  return Object.entries(map).map(([k, v]) => `${k} = ${v}`).join("\n");
}
function parseNumberMap(text: string): Record<string, number> {
  const map: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const [k, v] = line.split("=");
    if (k?.trim() && v?.trim() && Number.isFinite(Number(v))) map[k.trim().toLowerCase()] = Math.floor(Number(v));
  }
  return map;
}

/** A tag-list editor: current values as removable chips, an input to add, and
 *  click-to-add suggestion chips from recent imports. */
function StringList({
  label,
  values,
  onChange,
  suggestions,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const [input, setInput] = useState("");
  const add = (v: string) => {
    const t = v.trim();
    if (t && !values.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...values, t]);
  };
  const unused = suggestions.filter((s) => !values.some((x) => x.toLowerCase() === s.toLowerCase()));

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-slate">{label}</span>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-input bg-pigment-soft px-2 py-0.5 text-xs text-pigment">
              {v}
              <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
                <XCircle size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(input);
              setInput("");
            }
          }}
          placeholder={placeholder}
          className="flex-1"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            add(input);
            setInput("");
          }}
        >
          Add
        </Button>
      </div>
      {unused.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {unused.slice(0, 30).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="rounded-input border border-line bg-canvas px-2 py-0.5 text-xs text-ink hover:bg-pigment-soft"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ResolutionRulesEditor({
  shopId,
  platform,
  initialFigureRules,
  initialStyleRules,
  initialNonPortraitSkus,
  initialNonPortraitTitles,
  initialPhotoRequestEnabled,
  optionNames,
  skuSuggestions,
  titleSuggestions,
}: {
  shopId: string;
  platform: "etsy" | "shopify";
  initialFigureRules: FigureRule[];
  initialStyleRules: StyleRule[];
  initialNonPortraitSkus: string[];
  initialNonPortraitTitles: string[];
  initialPhotoRequestEnabled: boolean;
  optionNames: string[];
  skuSuggestions: string[];
  titleSuggestions: string[];
}) {
  const [figure, setFigure] = useState<FigureDraft[]>(
    initialFigureRules.map((r) => ({ match: r.match, type: r.type, mapText: mapToText(r.map) })),
  );
  const [style, setStyle] = useState<StyleDraft[]>(
    initialStyleRules.map((r) => ({ match: r.match })),
  );
  const [skus, setSkus] = useState<string[]>(initialNonPortraitSkus);
  const [titles, setTitles] = useState<string[]>(initialNonPortraitTitles);
  const [photoReq, setPhotoReq] = useState<boolean>(initialPhotoRequestEnabled);
  const [saving, startSave] = useTransition();
  const [reresolving, startReresolve] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);
  const [summary, setSummary] = useState<ReresolveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setFig = (i: number, patch: Partial<FigureDraft>) =>
    setFigure((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setSty = (i: number, patch: Partial<StyleDraft>) =>
    setStyle((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  function onSave() {
    setSaved(null);
    setError(null);
    const figureRules: FigureRule[] = figure
      .filter((r) => r.match.trim())
      .map((r) =>
        r.type === "map"
          ? { match: r.match.trim(), type: "map", map: parseNumberMap(r.mapText) }
          : { match: r.match.trim(), type: "integer" },
      );
    const styleRules: StyleRule[] = style.filter((r) => r.match.trim()).map((r) => ({ match: r.match.trim() }));
    startSave(async () => {
      try {
        await saveShopResolutionRules({
          shopId,
          figureRules,
          styleRules,
          nonPortraitSkus: skus,
          nonPortraitTitles: titles,
          photoRequestEnabled: photoReq,
        });
        setSaved("Rules saved.");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  function onReresolve() {
    setSummary(null);
    setError(null);
    startReresolve(async () => {
      try {
        setSummary(await reresolveShopOrders(shopId));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Re-resolve failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-card border border-line p-3">
      <div>
        <h4 className="text-sm font-semibold text-ink">Figure &amp; style rules</h4>
        <p className="text-xs text-slate">
          Match is case-insensitive and ignores trailing punctuation. Click a suggested option
          name to add a rule for it.
        </p>
      </div>

      {optionNames.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-slate">Option names seen in recent imports:</span>
          <div className="flex flex-wrap gap-1">
            {optionNames.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setFigure((rs) => [...rs, { match: name, type: "integer", mapText: "" }])}
                className="rounded-input border border-line bg-canvas px-2 py-0.5 text-xs text-ink hover:bg-pigment-soft"
                title="Add a figure rule for this option"
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Figure rules */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-ink">Figure count rules</span>
        {figure.length === 0 && <p className="text-xs text-slate">No figure rules yet.</p>}
        {figure.map((r, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-input border border-line p-2">
            <div className="flex items-end gap-2">
              <Input
                label="Option name contains"
                value={r.match}
                onChange={(e) => setFig(i, { match: e.target.value })}
                placeholder="Number of Pets"
                className="flex-1"
              />
              <Select
                label="Type"
                value={r.type}
                onChange={(e) => setFig(i, { type: e.target.value as "integer" | "map" })}
                className="w-32"
              >
                <option value="integer">Integer</option>
                <option value="map">Value map</option>
              </Select>
              <button
                type="button"
                onClick={() => setFigure((rs) => rs.filter((_, j) => j !== i))}
                className="mb-1 text-slate hover:text-rose"
                aria-label="Remove rule"
              >
                <XCircle size={18} />
              </button>
            </div>
            {r.type === "map" && (
              <Textarea
                label="Value map"
                value={r.mapText}
                onChange={(e) => setFig(i, { mapText: e.target.value })}
                rows={3}
                hint="One per line: value = count (e.g. `two pets = 2`)"
              />
            )}
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setFigure((rs) => [...rs, { match: "", type: "integer", mapText: "" }])}
          >
            <Plus size={16} /> Add figure rule
          </Button>
        </div>
      </div>

      {/* Style rules */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-ink">Style rules</span>
        <p className="text-xs text-slate">The matched option&apos;s value becomes the style.</p>
        {style.map((r, i) => (
          <div key={i} className="flex items-end gap-2">
            <Input
              label="Option name contains"
              value={r.match}
              onChange={(e) => setSty(i, { match: e.target.value })}
              placeholder="Print On"
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => setStyle((rs) => rs.filter((_, j) => j !== i))}
              className="mb-1 text-slate hover:text-rose"
              aria-label="Remove rule"
            >
              <XCircle size={18} />
            </button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setStyle((rs) => [...rs, { match: "" }])}
          >
            <Plus size={16} /> Add style rule
          </Button>
        </div>
      </div>

      {/* Non-portrait classification */}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-xs font-medium text-ink">Non-portrait orders</span>
        <p className="text-xs text-slate">
          Orders whose lines are all non-portrait (add-ons, extra prints) import as
          &ldquo;fulfilment only&rdquo; — no design, no proof, no photo request.
        </p>
        <StringList
          label="Non-portrait SKUs (exact match)"
          values={skus}
          onChange={setSkus}
          suggestions={skuSuggestions}
          placeholder="e.g. RUSH-UPGRADE"
        />
        <StringList
          label="Non-portrait product titles (contains)"
          values={titles}
          onChange={setTitles}
          suggestions={titleSuggestions}
          placeholder="e.g. Priority Upgrade"
        />
      </div>

      {/* Photo-request behaviour */}
      <label className="flex items-start gap-2 border-t border-line pt-3">
        <input
          type="checkbox"
          checked={photoReq}
          onChange={(e) => setPhotoReq(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-sm text-ink">
          Automatically email a photo request when an order needs photos
          <span className="ml-1 rounded bg-canvas px-1 text-xs text-slate">
            {photoReq ? "ON" : "OFF — default"}
          </span>
          <span className="block text-xs text-slate">
            Off for every shop until you turn it on here. A VA can still send a photo
            request manually from an order at any time.
            {platform === "shopify"
              ? " (Shopify collects photos at checkout — a Shopify order missing photos is flagged in the queue.)"
              : " (Etsy customers upload via the emailed link.)"}
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button type="button" size="sm" onClick={onSave} loading={saving}>
          Save rules
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onReresolve} loading={reresolving}>
          Re-resolve existing orders
        </Button>
        {saved && <span className="text-sm text-sage">{saved}</span>}
        {error && <span className="text-sm text-rose">{error}</span>}
      </div>
      {summary && (
        <p className="text-sm text-slate">
          Re-resolved {summary.ordersProcessed} order{summary.ordersProcessed === 1 ? "" : "s"}:{" "}
          {summary.itemsResolved} resolved, {summary.stillUnresolved} still unresolved,{" "}
          {summary.addOnsRemoved} add-on line{summary.addOnsRemoved === 1 ? "" : "s"} removed,{" "}
          {summary.namesBackfilled} order number{summary.namesBackfilled === 1 ? "" : "s"} backfilled,{" "}
          {summary.reclassified} re-classified, {summary.reclassifySkipped} skipped (designer
          already working)
          {summary.refetched > 0 ? ` · ${summary.refetched} re-fetched from Shopify.` : "."}
        </p>
      )}
    </div>
  );
}
