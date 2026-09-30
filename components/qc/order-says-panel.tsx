import { styleLabel } from "@/lib/utils";
import type { QcOrderSays } from "@/lib/qc/data";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

/**
 * What was ordered, straight from the order data, so a checker never has to
 * open another tab to know what "matches" means: listing title, product and
 * size, the personalization text and the buyer's notes, verbatim.
 */
export function OrderSaysPanel({ says }: { says: QcOrderSays }) {
  const empty = !says.items.length && !says.personalization && !says.buyerNote && !says.notes;
  return (
    <section aria-label="Order says" className="mb-4 rounded-input bg-canvas p-3" data-testid="order-says">
      <h2 className="font-display text-base font-semibold text-ink">Order says</h2>
      {empty ? (
        <p className="mt-1 text-sm text-slate">The order has no details saved.</p>
      ) : (
        <dl className="mt-2 flex max-h-64 flex-col gap-2.5 overflow-y-auto pr-1">
          {says.items.map((it, i) => {
            const size = it.options.find((o) => /size|canvas|dimension/i.test(o.name));
            const others = it.options.filter((o) => o !== size);
            return (
              <div key={i} className="flex flex-col gap-2.5">
                <Row label={says.items.length > 1 ? `Listing ${i + 1}` : "Listing"}>{it.title || "Portrait"}</Row>
                <Row label="Product and size">
                  {[
                    it.productType === "physical" ? "Physical" : "Digital",
                    it.figureCount != null ? `${it.figureCount} figure${it.figureCount === 1 ? "" : "s"}` : null,
                    it.style ? styleLabel(it.style) : null,
                    size ? `Size: ${size.value}` : "Size: not set",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Row>
                {others.map((o, j) => (
                  <Row key={j} label={o.name.replace(/[:：]\s*$/, "")}>{o.value}</Row>
                ))}
              </div>
            );
          })}
          {says.personalization && <Row label="Personalization">{says.personalization}</Row>}
          {says.buyerNote && <Row label="Buyer note">{says.buyerNote}</Row>}
          {says.notes && <Row label="Notes on the order">{says.notes}</Row>}
        </dl>
      )}
    </section>
  );
}
