import type { Metadata } from "next";

import { getUploadView } from "@/lib/uploads/data";
import { UploadClient } from "./upload-client";

// Token-scoped and never static: no caching, no indexing.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Send us your photos",
  robots: { index: false, follow: false },
};

export default async function UploadPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const view = await getUploadView(token);

  if (!view) return <InvalidLink />;

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-8 sm:py-12">
      <header className="flex flex-col items-center gap-3 text-center">
        {view.businessLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={view.businessLogoUrl}
            alt={view.businessName}
            className="h-12 w-auto object-contain"
          />
        ) : (
          <span className="font-display text-2xl font-semibold text-ink">
            {view.businessName}
          </span>
        )}
        <div className="flex flex-col gap-0.5">
          <h1 className="text-2xl font-semibold text-ink">Send us your photos</h1>
          <p className="text-sm text-slate">Order {view.orderNumber}</p>
        </div>
      </header>

      <UploadClient
        token={token}
        ask={view.ask}
        detail={view.detail}
        receivedCount={view.receivedCount}
        open={view.open}
        devStore={view.devStore}
      />

      <footer className="pt-2 text-center text-xs text-slate">
        Questions? Reply to our message on Etsy.
      </footer>
    </main>
  );
}

function InvalidLink() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-2xl font-semibold text-ink">Link not found</h1>
      <p className="text-sm text-slate">
        This upload link is invalid or has expired. If you think this is a
        mistake, please reply to the email we sent you.
      </p>
    </main>
  );
}
