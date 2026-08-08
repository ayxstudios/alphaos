"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Input, Select, useToast } from "@/components/ui";
import { AlertTriangle } from "@/components/ui/icons";
import {
  assignProductToStyle,
  createStyleFromProduct,
  ignoreProduct,
  unignoreProduct,
  type ActionResult,
} from "@/app/(app)/styles/actions";

export type UnrecognisedProduct = { title: string | null; sku: string | null; orders: number };
export type IgnoredProduct = { id: string; title: string | null; sku: string | null };

const NEW = "__new__";

export function UnrecognisedPanel({
  products,
  ignored,
  styles,
}: {
  products: UnrecognisedProduct[];
  ignored: IgnoredProduct[];
  styles: { id: string; name: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  function run(action: () => Promise<ActionResult>, ok: string) {
    start(async () => {
      const res = await action();
      if (!res.ok) {
        toast({ variant: "danger", title: "Didn't save", description: res.message });
        return;
      }
      toast({ variant: "success", title: ok });
      router.refresh();
    });
  }

  if (products.length === 0 && ignored.length === 0) return null;

  return (
    <div className="rounded-card border border-amber/30 bg-amber/5 p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="text-amber" />
        <h2 className="text-base font-semibold text-ink">Unrecognised products</h2>
        {products.length > 0 && <Badge variant="warning">{products.length}</Badge>}
      </div>
      <p className="mt-0.5 text-sm text-slate">
        These products came in without a style. Teach the system once and every future sale of that product is recognised automatically.
      </p>

      {products.length === 0 ? (
        <p className="mt-3 text-sm text-slate">Nothing waiting — every product maps to a style.</p>
      ) : (
        <div className="mt-3 flex flex-col divide-y divide-amber/20 overflow-hidden rounded-input border border-amber/20 bg-surface">
          {products.map((p) => (
            <ProductRow key={`${p.sku ?? ""}|${p.title ?? ""}`} product={p} styles={styles} run={run} pending={pending} />
          ))}
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
}: {
  product: UnrecognisedProduct;
  styles: { id: string; name: string }[];
  run: (action: () => Promise<ActionResult>, ok: string) => void;
  pending: boolean;
}) {
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const productArg = { title: product.title, sku: product.sku };

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
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{product.title ?? "Untitled product"}</p>
        <p className="text-xs text-slate">
          {product.sku ? `SKU ${product.sku} · ` : ""}
          {product.orders} order{product.orders === 1 ? "" : "s"}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={choice}
          onChange={(e) => setChoice(e.currentTarget.value)}
          aria-label="Assign to style"
          className="h-9 w-44"
        >
          <option value="">Choose style…</option>
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
          onClick={apply}
          loading={pending}
          disabled={!choice || (choice === NEW && !newName.trim())}
        >
          {choice === NEW ? "Create" : "Assign"}
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
