"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Input, Select, useToast, Checkbox } from "@/components/ui";
import { AlertTriangle, ChevronDown } from "@/components/ui/icons";
import { styleLabel } from "@/lib/utils";
import {
  assignProductToStyle,
  createStyleFromProduct,
  confirmProductsAsDefault,
  ignoreProduct,
  unignoreProduct,
  type ActionResult,
} from "@/app/(app)/styles/actions";

export type UnrecognisedProduct = {
  title: string | null;
  sku: string | null;
  orders: number;
  /** "default" = fell back to the default style (moving, unconfirmed); "none" = no style. */
  via: "default" | "none";
  defaultStyle: string | null;
};
export type IgnoredProduct = { id: string; title: string | null; sku: string | null };

const NEW = "__new__";
const keyOf = (p: { title: string | null; sku: string | null }) => `${p.sku ?? ""}|${p.title ?? ""}`;

export function UnrecognisedPanel({
  products,
  ignored,
  styles,
  defaultStyleName,
}: {
  products: UnrecognisedProduct[];
  ignored: IgnoredProduct[];
  styles: { id: string; name: string }[];
  defaultStyleName: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const defaulted = useMemo(() => products.filter((p) => p.via === "default"), [products]);
  const noStyle = useMemo(() => products.filter((p) => p.via === "none"), [products]);

  function run(action: () => Promise<ActionResult>, ok: string) {
    start(async () => {
      const res = await action();
      if (!res.ok) {
        toast({ variant: "danger", title: "Didn't save", description: res.message });
        return;
      }
      toast({ variant: "success", title: ok });
      setSelected(new Set());
      router.refresh();
    });
  }

  if (products.length === 0 && ignored.length === 0) return null;

  const allDefaultedSelected = defaulted.length > 0 && defaulted.every((p) => selected.has(keyOf(p)));
  const toConfirm = (selected.size ? defaulted.filter((p) => selected.has(keyOf(p))) : defaulted).map((p) => ({
    title: p.title,
    sku: p.sku,
  }));

  return (
    <details className="group rounded-card bg-surface shadow-card" open={products.length > 0 || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <AlertTriangle size={16} className={products.length ? "text-amber" : "text-slate"} />
        <span className="text-sm font-semibold text-ink">Products to confirm</span>
        {products.length > 0 ? <Badge variant="warning">{products.length}</Badge> : <span className="text-xs text-slate">All recognised</span>}
        <span className="ml-auto hidden text-xs text-slate sm:inline">Confirm once and it is remembered</span>
        <ChevronDown size={16} className="ml-auto shrink-0 text-slate transition-transform group-open:rotate-180 sm:ml-0" />
      </summary>
      <div className="border-t border-line/70 px-4 pb-4">

      {/* Defaulted — moving on the default style, but unconfirmed. */}
      {defaulted.length > 0 && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2 rounded-t-input bg-amber/5 px-3 py-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-xs font-medium text-slate sm:min-h-0 sm:gap-2">
              <Checkbox
                checked={allDefaultedSelected}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(defaulted.map(keyOf)) : new Set())
                }
              />
              Went to {defaultStyleName ? styleLabel(defaultStyleName) : "the default style"} by default · {defaulted.length}
            </label>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              loading={pending}
              disabled={!defaultStyleName || toConfirm.length === 0}
              onClick={() => run(() => confirmProductsAsDefault(toConfirm), "Confirmed")}
            >
              Confirm {selected.size ? selected.size : defaulted.length} as {defaultStyleName ? styleLabel(defaultStyleName) : "default"}
            </Button>
          </div>
          <div className="flex flex-col divide-y divide-line/70 overflow-hidden rounded-b-input bg-canvas/40">
            {defaulted.map((p) => (
              <ProductRow
                key={keyOf(p)}
                product={p}
                styles={styles}
                run={run}
                pending={pending}
                checked={selected.has(keyOf(p))}
                onToggle={() =>
                  setSelected((cur) => {
                    const next = new Set(cur);
                    if (next.has(keyOf(p))) next.delete(keyOf(p));
                    else next.add(keyOf(p));
                    return next;
                  })
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* No style at all — blocked until assigned. */}
      {noStyle.length > 0 && (
        <div className="mt-3">
          <p className="px-1 pb-1 text-xs font-medium text-slate">No style · {noStyle.length}</p>
          <div className="flex flex-col divide-y divide-line/70 overflow-hidden rounded-input bg-canvas/40">
            {noStyle.map((p) => (
              <ProductRow key={keyOf(p)} product={p} styles={styles} run={run} pending={pending} />
            ))}
          </div>
        </div>
      )}

      {ignored.length > 0 && (
        <details className="mt-3 rounded-input bg-canvas/40">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate">
            Ignored products ({ignored.length})
          </summary>
          <div className="flex flex-col divide-y divide-line/70 border-t border-line/70">
            {ignored.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                <span className="min-w-0 truncate text-ink">{p.title ?? "Untitled product"}</span>
                {p.sku && <span className="text-xs text-slate">{skuLabel(p.sku)}</span>}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={pending}
                  onClick={() => run(() => unignoreProduct(p.id), "Product restored")}
                >
                  Un-ignore
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
      </div>
    </details>
  );
}

function ProductRow({
  product,
  styles,
  run,
  pending,
  checked,
  onToggle,
}: {
  product: UnrecognisedProduct;
  styles: { id: string; name: string }[];
  run: (action: () => Promise<ActionResult>, ok: string) => void;
  pending: boolean;
  checked?: boolean;
  onToggle?: () => void;
}) {
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const [newRate, setNewRate] = useState("");
  const productArg = { title: product.title, sku: product.sku };
  const correcting = product.via === "default";

  function apply() {
    if (choice === NEW) {
      const name = newName.trim();
      const rate = newRate.trim();
      if (!name || !rate) return;
      run(() => createStyleFromProduct(name, rate, productArg), `Learned as ${name}`);
    } else if (choice) {
      const styleName = styles.find((s) => s.id === choice)?.name ?? "style";
      run(() => assignProductToStyle(choice, productArg), `Learned as ${styleName}`);
    }
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center">
      {/* Checkbox and product side by side at every size; the title wraps
          on a phone instead of being cut short. */}
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        {onToggle && (
          // The checkbox itself is a 44px tap area on a phone.
          <label className="flex shrink-0 pt-0.5 sm:pt-0">
            <Checkbox
              checked={!!checked}
              onChange={onToggle}
              aria-label={`Select ${product.title ?? "product"}`}
            />
          </label>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink sm:truncate">{product.title ?? "Untitled product"}</p>
          <p className="text-xs text-slate">
            {product.sku ? `${skuLabel(product.sku)} · ` : ""}
            {product.orders} order{product.orders === 1 ? "" : "s"}
            {product.via === "default" && product.defaultStyle ? ` · went to ${styleLabel(product.defaultStyle)} by default` : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={choice}
          onChange={(e) => setChoice(e.currentTarget.value)}
          aria-label={correcting ? "Correct to a different style" : "Assign to style"}
          className="h-9 w-44"
        >
          <option value="">{correcting ? "Correct to…" : "Choose style…"}</option>
          {styles.map((s) => (
            <option key={s.id} value={s.id}>{styleLabel(s.name)}</option>
          ))}
          <option value={NEW}>+ New style…</option>
        </Select>
        {choice === NEW && (
          <>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New style name"
              aria-label="New style name"
              className="h-9 w-40"
            />
            <Input
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
              placeholder="Rate"
              inputMode="decimal"
              aria-label="New style rate per figure"
              className="h-9 w-24"
            />
          </>
        )}
        {choice && (
          <Button
            type="button"
            size="sm"
            onClick={apply}
            loading={pending}
            disabled={choice === NEW && (!newName.trim() || !newRate.trim())}
          >
            {choice === NEW ? "Create" : correcting ? "Correct" : "Assign"}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => ignoreProduct(productArg), "Product ignored")}
        >
          Ignore
        </Button>
      </div>
    </div>
  );
}

/** "SKU 1249", but never "SKU SKU-1018-1". */
function skuLabel(sku: string): string {
  return /^sku\b/i.test(sku.trim()) ? sku.trim() : `SKU ${sku}`;
}
