export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-1">
      {/* Brand panel — decorative, hidden on small screens */}
      <div className="relative hidden w-[42%] shrink-0 overflow-hidden bg-ink lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.14]"
          style={{
            backgroundImage:
              "radial-gradient(circle, #f7f5ef 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-pigment/30 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 -left-16 size-80 rounded-full bg-sage/20 blur-3xl"
        />

        <div className="relative z-10 flex items-center gap-2.5 px-10 pt-10">
          <span className="flex size-9 items-center justify-center rounded-[10px] bg-canvas font-display text-base text-ink">
            A
          </span>
          <span className="font-display text-lg text-canvas">AlphaOS</span>
        </div>

        <div className="relative z-10 px-10 pb-12">
          <p className="font-display text-4xl leading-tight text-canvas">
            Every order,
            <br />
            one queue.
          </p>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-canvas/65">
            From intake to delivery across 14 shops — Etsy and Shopify,
            design, QC, and fulfilment, tracked in one place instead of a
            Trello board no one trusts.
          </p>
          <div className="mt-8 flex items-center gap-6 text-xs text-canvas/50">
            <span>14 shops</span>
            <span className="h-1 w-1 rounded-full bg-canvas/30" />
            <span>50 designers</span>
            <span className="h-1 w-1 rounded-full bg-canvas/30" />
            <span>~2,000 orders / month</span>
          </div>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
