"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, DataPanel, Input, useToast } from "@/components/ui";
import { saveBusinessDetails } from "@/app/(app)/settings/actions";

export type BusinessDetailsVM = { id: string; name: string; logoUrl: string | null };

/**
 * Business name and logo: what customers see at the top of the photo upload
 * and proof pages, and {{business_name}} in emails.
 */
export function BusinessDetailsCard({ business }: { business: BusinessDetailsVM }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(business.name);
  const [logoUrl, setLogoUrl] = useState(business.logoUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startSave] = useTransition();
  const preview = /^https:\/\/\S+$/i.test(logoUrl.trim()) ? logoUrl.trim() : null;
  // A link that is not an image shows a clear line, not a broken picture.
  const [brokenLogo, setBrokenLogo] = useState<string | null>(null);

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startSave(async () => {
      let res: Awaited<ReturnType<typeof saveBusinessDetails>>;
      try {
        res = await saveBusinessDetails(business.id, { name, logoUrl });
      } catch {
        setError("Could not save. Try again.");
        return;
      }
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({ variant: "success", title: "Business details saved", description: "Customers see them on their next visit." });
      router.refresh();
    });
  }

  return (
    <DataPanel className="p-4">
      <form onSubmit={save} className="flex flex-col gap-4">
        <p className="text-sm text-slate">
          Shown to customers at the top of the photo upload and proof pages, and used as the business name in emails.
        </p>
        <Input
          label="Business name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={80}
          autoComplete="off"
          required
          disabled={pending}
        />
        <Input
          label="Logo link"
          type="url"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.currentTarget.value)}
          placeholder="https://..."
          hint="A public https image (PNG or SVG works best). Leave empty to show the name as text."
          autoComplete="off"
          disabled={pending}
        />
        <div className="flex min-h-16 items-center gap-3 rounded-input border border-line bg-canvas p-3">
          <span className="text-xs text-slate">Customers see</span>
          {preview && brokenLogo === preview ? (
            <span className="text-sm text-rose">That link is not a picture. Customers would see the name instead.</span>
          ) : preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt={name}
              className="h-10 w-auto max-w-[12rem] object-contain"
              onError={() => setBrokenLogo(preview)}
            />
          ) : (
            <span className="font-display text-lg font-semibold text-ink">{name.trim() || "Your business"}</span>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-rose">
            {error}
          </p>
        )}
        <Button type="submit" className="w-fit" loading={pending}>
          Save details
        </Button>
      </form>
    </DataPanel>
  );
}
