import type { Metadata } from "next";

import { getProofView } from "@/lib/proofs/data";
import { AlertTriangle, Lock } from "@/components/ui/icons";
import { ProofClient } from "./proof-client";

// Token-scoped and never static: no caching, no indexing.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your portrait proof",
  robots: { index: false, follow: false },
};

export default async function ProofPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const proof = await getProofView(token);

  if (!proof) return <InvalidLink />;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 px-4 py-10 sm:gap-10 sm:py-16">
      <header className="flex flex-col items-center gap-4 text-center">
        {proof.businessLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proof.businessLogoUrl}
            alt={proof.businessName}
            className="h-10 w-auto object-contain"
          />
        ) : (
          <span className="font-display text-xl text-ink">
            {proof.businessName}
          </span>
        )}

        <div className="flex flex-col items-center gap-2">
          <span className="font-mono text-xs font-medium uppercase tracking-[0.16em] text-slate">
            Proof review
          </span>
          <h1 className="font-display text-4xl leading-tight text-ink">
            Your portrait is ready
          </h1>
        </div>

        <span className="inline-flex items-center gap-1.5 rounded-chip border border-line bg-surface px-3 py-1 text-xs font-medium text-slate">
          Order
          <span className="font-mono tracking-wide text-ink">
            {proof.orderNumber}
          </span>
        </span>

        <p className="max-w-md text-base text-slate">
          Take a good look below. If it&rsquo;s everything you hoped for, approve
          it — or let us know what to change and we&rsquo;ll make it right.
        </p>
      </header>

      <ProofClient
        token={token}
        orderNumber={proof.orderNumber}
        hasPreview={proof.hasPreview}
        actionable={proof.actionable}
        initialDecision={proof.decision}
        decidedAt={proof.decidedAt}
      />

      <footer className="flex flex-col items-center gap-2 border-t border-line pt-6 text-center text-xs text-slate">
        <span className="font-medium text-ink">{proof.businessName}</span>
        <span className="inline-flex items-center gap-1.5">
          <Lock size={13} className="shrink-0" />
          Secure link, no account needed
        </span>
      </footer>
    </main>
  );
}

function InvalidLink() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-pigment-soft text-pigment">
        <AlertTriangle size={26} />
      </span>
      <h1 className="font-display text-3xl text-ink">Link not found</h1>
      <p className="max-w-sm text-sm text-slate">
        This proof link is invalid or has expired. If you think this is a
        mistake, please reply to the email we sent you.
      </p>
    </main>
  );
}
