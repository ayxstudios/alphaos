"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Input, Select, useToast } from "@/components/ui";
import { AlertTriangle } from "@/components/ui/icons";
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
    <div className="rounded-card border border-amber/30 bg-amber/5 p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="text-amber" />
        <h2 className="text-base font-semibold text-ink">Products to confirm</h2>
        {products.length > 0 && <Badge variant="warning">{products.length}</Badge>}
      </div>
      <p className="mt-0.5 text-sm text-slate">
        These products aren&apos;t matched by a rule yet. Confirm or correct them once and every future sale is recognised automatically.
      </p>

      {/* Defaulted — moving on the default style, but unconfirmed. */}
      {defaulted.length > 0 && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2 rounded-t-input border border-amber/20 bg-surface px-3 py-2">
            <label className="flex items-center gap-2 text-xs font-medium text-slate">
              <input
                type="checkbox"
                checked={allDefaultedSelected}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(defaulted.map(keyOf)) : new Set())
                }
                className="size-4 rounded border-line text-pigment focus:ring-pigment"
              />
              Defaulted to {defaultStyleName ?? "default"} · {defaulted.length}
            </label>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              loading={pending}
              disabled={!defaultStyleName || toConfirm.length === 0}
              onClick={() => run(() => confirmProductsAsDefault(toConfirm), "Confirmed")}
            >
              Confirm {selected.size ? selected.size : defaulted.length} as {defaultStyleName ?? "default"}
            </Button>
          </div>
          <div className="flex flex-col divide-y divide-amber/20 overflow-hidden rounded-b-input border-x border-b border-amber/20 bg-surface">
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
          <div className="flex flex-col divide-y divide-amber/20 overflow-hidden rounded-input border border-amber/20 bg-surface">
            {noStyle.map((p) => (
              <ProductRow key={keyOf(p)} product={p} styles={styles} run={run} pending={pending} />
            ))}
          </div>
        </div>
      )}

      {ignored.length > 0 && (
        <details className="mt-3 rounded-input border border-line bg-surface">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate">
            Ignored products ({ignored.length})
          </summary>
          <div className="flex flex-col divide-y divide-line border-t border-line">
            {ignored.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                <span className="min-w-0 truncate text-ink">{p.title ?? "Untitled product"}</span>
                {p.sku && <span className="text-xs text-slate">SKU {p.sku}</span>}
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
  const productArg = { title: product.title, sku: product.sku };
  const correcting = product.via === "default";

  function apply() {
    if (choice === NEW) {
      const name = newName.trim();
      if (!name) return;
      run(() => createStyleFromProduct(name, productArg), `Learned as ${name}`);
    } else if (choice) {
      const styleName = styles.find((s) => s.id === choice)?.name ?? "style";
      run(() => assignProductToStyle(choice, productArg), `Learned as ${styleName}`);
    }
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center">
      {onToggle && (
        <input
          type="checkbox"
          checked={!!checked}
          onChange={onToggle}
          aria-label={`Select ${product.title ?? "product"}`}
          className="size-4 shrink-0 rounded border-line text-pigment focus:ring-pigment"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{product.title ?? "Untitled product"}</p>
        <p className="text-xs text-slate">
          {product.sku ? `SKU ${product.sku} · ` : ""}
          {product.orders} order{product.orders === 1 ? "" : "s"}
          {product.via === "default" && product.defaultStyle ? ` · defaulted to ${product.defaultStyle}` : ""}
        </p>
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
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
          <option value={NEW}>+ New style…</option>
        </Select>
        {choice === NEW && (
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New style name"
            aria-label="New style name"
            className="h-9 w-40"
          />
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={apply}
          loading={pending}
          disabled={!choice || (choice === NEW && !newName.trim())}
        >
          {choice === NEW ? "Create" : correcting ? "Correct" : "Assign"}
        </Button>
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
