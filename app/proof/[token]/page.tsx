import type { Metadata } from "next";

import { getProofView } from "@/lib/proofs/data";
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
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8 sm:py-12">
      <header className="flex flex-col items-center gap-3 text-center">
        {proof.businessLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proof.businessLogoUrl}
            alt={proof.businessName}
            className="h-12 w-auto object-contain"
          />
        ) : (
          <span className="font-display text-2xl font-semibold text-ink">
            {proof.businessName}
          </span>
        )}
        <div className="flex flex-col gap-0.5">
          <h1 className="text-2xl font-semibold text-ink">Your portrait is ready</h1>
          <p className="text-sm text-slate">Order {proof.orderNumber}</p>
        </div>
        <p className="max-w-sm text-sm text-slate">
          Take a look below. If everything looks perfect, approve it — or let us
          know what to change.
        </p>
      </header>

      <ProofClient
        token={token}
        orderNumber={proof.orderNumber}
        hasPreview={proof.hasPreview}
        actionable={proof.actionable}
        initialDecision={proof.decision}
      />

      <footer className="pt-2 text-center text-xs text-slate">
        {proof.businessName}
      </footer>
    </main>
  );
}

function InvalidLink() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-2xl font-semibold text-ink">Link not found</h1>
      <p className="text-sm text-slate">
        This proof link is invalid or has expired. If you think this is a
        mistake, please reply to the email we sent you.
      </p>
    </main>
  );
}
