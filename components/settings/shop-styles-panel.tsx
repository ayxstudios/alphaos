"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";

import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { ChevronDown, X } from "@/components/ui/icons";
import { setShopStyles } from "@/app/(app)/settings/actions";

export type ShopStylesVM = {
  id: string;
  name: string;
  platform: "etsy" | "shopify";
  styles: string[];
};

/**
 * Per-shop limit on the portrait styles its order forms offer. Empty (the
 * default) means every style in Portrait Styles (/styles), which is where
 * styles and their per-figure rates live. Edits are optimistic (chips update
 * instantly) and persist in the background.
 */
export function ShopStylesPanel({ shops, catalog }: { shops: ShopStylesVM[]; catalog: string[] }) {
  return (
    <div className="grid gap-3">
      <p className="px-1 pt-2 text-sm text-slate">
        Styles and their rates live in{" "}
        <Link href="/styles" className="font-medium text-pigment underline">
          Portrait Styles
        </Link>
        . A shop offers all of them unless you pick some here to limit its order forms.
      </p>
      {shops.map((s) => (
        <ShopRow key={s.id} shop={s} catalog={catalog} />
      ))}
    </div>
  );
}

function ShopRow({ shop, catalog }: { shop: ShopStylesVM; catalog: string[] }) {
  const toast = useToast();
  const [, startBg] = useTransition();
  const [styles, setStyles] = useState<string[]>(shop.styles);
  const [draft, setDraft] = useState("");
  const listId = `shop-styles-${shop.id}`;
  const known = new Set(catalog.map((c) => c.toLowerCase()));
  const offered = catalog.filter((c) => !styles.some((s) => s.toLowerCase() === c.toLowerCase()));

  useEffect(() => setStyles(shop.styles), [shop.styles]);

  function persist(next: string[]) {
    const prev = styles;
    setStyles(next); // optimistic
    startBg(async () => {
      const res = await setShopStyles(shop.id, next);
      if (!res.ok) {
        setStyles(prev);
        toast({ variant: "danger", title: "Couldn’t save styles", description: res.message });
        return;
      }
      setStyles(res.styles); // the catalog's spelling
    });
  }

  function add() {
    // Allow comma-separated bulk entry.
    const parts = draft.split(",").map((p) => p.trim()).filter(Boolean);
    setDraft("");
    if (!parts.length) return;
    const lower = new Set(styles.map((s) => s.toLowerCase()));
    const merged = [...styles];
    for (const p of parts) {
      if (!lower.has(p.toLowerCase())) {
        lower.add(p.toLowerCase());
        merged.push(p);
      }
    }
    if (merged.length !== styles.length) persist(merged);
  }

  function remove(style: string) {
    persist(styles.filter((s) => s !== style));
  }

  const summary = styles.length
    ? `${styles.length} of ${catalog.length} style${catalog.length === 1 ? "" : "s"}`
    : `All ${catalog.length} style${catalog.length === 1 ? "" : "s"}`;

  return (
    <details className="group rounded-input bg-canvas/70">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink">{shop.name}</span>
            <span className="rounded bg-canvas px-1.5 py-0.5 text-xs font-medium capitalize text-slate">
              {shop.platform}
            </span>
            <span className="text-xs text-slate">{summary}</span>
          </div>
        </div>
        <ChevronDown size={16} className="text-slate transition-transform group-open:rotate-180" />
      </summary>

      <div className="border-t border-line p-3">
        <div className="flex w-full gap-2 sm:w-72">
          <input
            value={draft}
            list={listId}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Limit to a style..."
            aria-label={`Limit ${shop.name} to a style`}
            className={cn(
              "h-9 min-w-0 flex-1 rounded-input border border-line bg-canvas px-2.5 text-sm text-ink placeholder:text-slate",
              focusRing,
            )}
          />
          <datalist id={listId}>
            {offered.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={add}
            disabled={!draft.trim()}
            className={cn(
              "inline-flex h-9 items-center rounded-input bg-ink px-3 text-sm font-medium text-surface transition-opacity disabled:pointer-events-none disabled:opacity-40",
              focusRing,
            )}
          >
            Add
          </button>
        </div>

        <div className="mt-3 min-h-10 rounded-input bg-canvas/70 p-2">
          {styles.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {styles.map((s) => {
                const stale = !known.has(s.toLowerCase());
                return (
                  <span
                    key={s}
                    title={stale ? "Not in Portrait Styles any more: remove it" : undefined}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-input border py-1 pl-2.5 pr-1 text-xs font-medium",
                      stale ? "border-amber/30 bg-amber/10 text-amber" : "border-sage/20 bg-sage/10 text-sage",
                    )}
                  >
                    {s}
                    {stale && " (not in Portrait Styles)"}
                    <button
                      type="button"
                      aria-label={`Remove ${s}`}
                      onClick={() => remove(s)}
                      className={cn("rounded p-0.5 hover:bg-sage/20", focusRing)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : (
            <span className="inline-flex min-h-6 items-center text-xs text-slate">
              {catalog.length
                ? `Offers every style: ${catalog.join(", ")}.`
                : "No styles yet. Add them in Portrait Styles."}
            </span>
          )}
        </div>
      </div>
    </details>
  );
}
