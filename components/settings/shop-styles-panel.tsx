"use client";

import { useEffect, useState, useTransition } from "react";

import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { X } from "@/components/ui/icons";
import { setShopStyles } from "@/app/(app)/settings/actions";

export type ShopStylesVM = {
  id: string;
  name: string;
  platform: "etsy" | "shopify";
  styles: string[];
};

/**
 * Per-shop editor for the portrait styles a shop offers. These form the catalog
 * that designer styles are chosen from. Edits are optimistic (chips update
 * instantly) and persist in the background.
 */
export function ShopStylesPanel({ shops }: { shops: ShopStylesVM[] }) {
  return (
    <div className="divide-y divide-line">
      {shops.map((s) => (
        <ShopRow key={s.id} shop={s} />
      ))}
    </div>
  );
}

function ShopRow({ shop }: { shop: ShopStylesVM }) {
  const toast = useToast();
  const [, startBg] = useTransition();
  const [styles, setStyles] = useState<string[]>(shop.styles);
  const [draft, setDraft] = useState("");

  useEffect(() => setStyles(shop.styles), [shop.styles]);

  function persist(next: string[]) {
    const prev = styles;
    setStyles(next); // optimistic
    startBg(async () => {
      const res = await setShopStyles(shop.id, next);
      if (!res.ok) {
        setStyles(prev);
        toast({ variant: "danger", title: "Couldn’t save styles", description: res.message });
      }
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

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink">{shop.name}</span>
        <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] capitalize text-slate">
          {shop.platform}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {styles.map((s) => (
          <span
            key={s}
            className="inline-flex items-center gap-1 rounded bg-sage/10 py-0.5 pl-2 pr-1 text-xs text-sage"
          >
            {s}
            <button
              type="button"
              aria-label={`Remove ${s}`}
              onClick={() => remove(s)}
              className={cn("rounded p-0.5 hover:bg-sage/20", focusRing)}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {styles.length === 0 && (
          <span className="text-xs text-slate">No styles yet</span>
        )}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add style…"
          className={cn(
            "h-8 min-w-[8rem] flex-1 rounded-input border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-slate",
            focusRing,
          )}
        />
      </div>
    </div>
  );
}
