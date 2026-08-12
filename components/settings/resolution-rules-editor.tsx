"use client";

import { useMemo, useState, useTransition } from "react";

import { Button, InfoBubble, Input, Select, Textarea } from "@/components/ui";
import { Plus, XCircle } from "@/components/ui/icons";
import {
  saveShopResolutionRules,
  reresolveShopOrders,
} from "@/app/(app)/settings/actions";
import type { FigureRule } from "@/lib/integrations/figures";
import type { ReresolveSummary } from "@/lib/orders/resolution";

type FigureDraft = { match: string; type: "integer" | "map"; mapText: string };

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
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const add = (v: string) => {
    const t = v.trim();
    if (t && !values.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...values, t]);
  };
  const visibleValues = showAll ? values : values.slice(0, 5);
  const unused = useMemo(
    () =>
      suggestions
        .filter((s) => !values.some((x) => x.toLowerCase() === s.toLowerCase()))
        .filter((s) => !search.trim() || s.toLowerCase().includes(search.trim().toLowerCase()))
        .slice(0, 8),
    [search, suggestions, values],
  );

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-ink">{label}</span>
      {values.length > 0 && (
        <div className="overflow-hidden rounded-input border border-line bg-canvas">
          {visibleValues.map((v) => (
            <div key={v} className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-xs text-ink">{v}</span>
              <button
                type="button"
                className="text-slate hover:text-rose"
                onClick={() => onChange(values.filter((x) => x !== v))}
                aria-label={`Remove ${v}`}
              >
                <XCircle size={13} />
              </button>
            </div>
          ))}
          {values.length > 5 && (
            <button
              type="button"
              className="w-full px-2.5 py-1.5 text-left text-xs font-medium text-pigment hover:bg-pigment-soft"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? "Show fewer" : `Show all ${values.length}`}
            </button>
          )}
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
      {suggestions.length > 0 && (
        <div className="relative">
          <Input
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={`Find imported ${label.toLowerCase()}...`}
            className="h-9"
          />
          {search.trim() && (
            <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-input border border-line bg-surface shadow-md">
              {unused.length ? (
                unused.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="block w-full truncate px-3 py-2 text-left text-xs text-ink hover:bg-pigment-soft"
                    onClick={() => {
                      add(s);
                      setSearch("");
                    }}
                  >
                    {s}
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-xs text-slate">No matches</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ResolutionRulesEditor({
  shopId,
  initialFigureRules,
  initialNonPortraitSkus,
  initialNonPortraitTitles,
  initialPhotoRequestEnabled,
  optionNames,
  skuSuggestions,
  titleSuggestions,
}: {
  shopId: string;
  initialFigureRules: FigureRule[];
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
  const [skus, setSkus] = useState<string[]>(initialNonPortraitSkus);
  const [titles, setTitles] = useState<string[]>(initialNonPortraitTitles);
  const [photoReq, setPhotoReq] = useState<boolean>(initialPhotoRequestEnabled);
  const [saving, startSave] = useTransition();
  const [reresolving, startReresolve] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);
  const [summary, setSummary] = useState<ReresolveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [optionSearch, setOptionSearch] = useState("");

  const setFig = (i: number, patch: Partial<FigureDraft>) =>
    setFigure((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const optionMatches = useMemo(
    () =>
      optionNames
        .filter((name) => !optionSearch.trim() || name.toLowerCase().includes(optionSearch.trim().toLowerCase()))
        .slice(0, 8),
    [optionNames, optionSearch],
  );

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
    startSave(async () => {
      try {
        await saveShopResolutionRules({
          shopId,
          figureRules,
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
    <div className="flex flex-col gap-4 rounded-input border border-line p-3">
      <h4 className="text-sm font-semibold text-ink">Import rules</h4>

      {optionNames.length > 0 && (
        <div className="relative">
          <Input
            label="Imported option names"
            value={optionSearch}
            onChange={(event) => setOptionSearch(event.currentTarget.value)}
            placeholder="Search option names..."
          />
          {optionSearch.trim() && (
            <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-input border border-line bg-surface shadow-md">
              {optionMatches.length ? (
                optionMatches.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      setFigure((rs) => [...rs, { match: name, type: "integer", mapText: "" }]);
                      setOptionSearch("");
                    }}
                    className="block w-full truncate px-3 py-2 text-left text-xs text-ink hover:bg-pigment-soft"
                  >
                    {name}
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-xs text-slate">No matches</div>
              )}
            </div>
          )}
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
                placeholder="two pets = 2"
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

      {/* Non-portrait classification */}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-xs font-medium text-ink">Non-portrait orders</span>
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
          <span className="inline-flex items-center gap-1.5">
            Auto photo request
            <InfoBubble label="Auto photo request">
              Sends the customer a photo upload email when an imported order has no usable photos. Keep off for shops that already collect photos at checkout.
            </InfoBubble>
          </span>
          <span className="ml-1 rounded bg-canvas px-1 text-xs text-slate">
            {photoReq ? "ON" : "OFF — default"}
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
