"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { savePrintProviderCredentials, clearPrintProviderCredentials } from "@/app/(app)/settings/actions";
import { Badge, Button, Input, DataPanel, useToast } from "@/components/ui";
import { Printer } from "@/components/ui/icons";

export type PrintProviderCredentialsVM = {
  businessId: string;
  gelato: { hasApiKey: boolean; hasWebhookSecret: boolean };
  lumaprints: { hasUsername: boolean; hasPassword: boolean; storeId: string | null; sandbox: boolean };
  gelatoWebhookUrl: string;
};

export function PrintProviderCredentialsPanel({ creds }: { creds: PrintProviderCredentialsVM }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <GelatoCard creds={creds} />
      <LumaCard creds={creds} />
    </div>
  );
}

function GelatoCard({ creds }: { creds: PrintProviderCredentialsVM }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [clearing, startClear] = useTransition();
  const connected = creds.gelato.hasApiKey;

  function onSave(formData: FormData) {
    start(async () => {
      try {
        await savePrintProviderCredentials(formData);
        toast({ variant: "success", title: "Gelato credentials saved" });
        router.refresh();
      } catch (error) {
        toast({ variant: "danger", title: "Not saved", description: error instanceof Error ? error.message : "Failed to save." });
      }
    });
  }

  function onClear() {
    startClear(async () => {
      await clearPrintProviderCredentials(creds.businessId, "gelato");
      toast({ variant: "success", title: "Gelato credentials removed" });
      router.refresh();
    });
  }

  return (
    <DataPanel className="p-4">
      <div className="mb-4 flex items-center gap-2">
        <Printer size={17} className="text-ink" />
        <span className="font-medium text-ink">Gelato</span>
        <Badge variant={connected ? "success" : "neutral"} dot>
          {connected ? "Connected" : "Not connected"}
        </Badge>
      </div>
      <form action={onSave} className="flex flex-col gap-3">
        <input type="hidden" name="businessId" value={creds.businessId} />
        <input type="hidden" name="provider" value="gelato" />
        <Input
          label="API key (X-API-KEY)"
          name="apiKey"
          type="password"
          placeholder={creds.gelato.hasApiKey ? "Set - leave blank to keep" : "Paste the key from the Gelato dashboard"}
          autoComplete="off"
        />
        <Input
          label="Webhook secret"
          name="webhookSecret"
          type="password"
          placeholder={creds.gelato.hasWebhookSecret ? "Set - leave blank to keep" : "A secret you choose"}
          autoComplete="off"
        />
        <p className="text-xs text-slate">
          Register this URL as the Gelato webhook, with your webhook secret appended as{" "}
          <code className="rounded bg-canvas px-1">?secret=...</code>:
          <br />
          <code className="break-all rounded bg-canvas px-1">{creds.gelatoWebhookUrl}</code>
        </p>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" loading={pending} disabled={pending}>
            Save
          </Button>
          {connected && (
            <Button type="button" size="sm" variant="secondary" loading={clearing} disabled={clearing} onClick={onClear}>
              Remove
            </Button>
          )}
        </div>
      </form>
    </DataPanel>
  );
}

function LumaCard({ creds }: { creds: PrintProviderCredentialsVM }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [clearing, startClear] = useTransition();
  const [sandbox, setSandbox] = useState(creds.lumaprints.sandbox);
  const connected = creds.lumaprints.hasUsername && creds.lumaprints.hasPassword;

  function onSave(formData: FormData) {
    start(async () => {
      try {
        await savePrintProviderCredentials(formData);
        toast({ variant: "success", title: "Luma Prints credentials saved" });
        router.refresh();
      } catch (error) {
        toast({ variant: "danger", title: "Not saved", description: error instanceof Error ? error.message : "Failed to save." });
      }
    });
  }

  function onClear() {
    startClear(async () => {
      await clearPrintProviderCredentials(creds.businessId, "lumaprints");
      toast({ variant: "success", title: "Luma Prints credentials removed" });
      router.refresh();
    });
  }

  return (
    <DataPanel className="p-4">
      <div className="mb-4 flex items-center gap-2">
        <Printer size={17} className="text-ink" />
        <span className="font-medium text-ink">Luma Prints</span>
        <Badge variant={connected ? "success" : "neutral"} dot>
          {connected ? "Connected" : "Not connected"}
        </Badge>
      </div>
      <form action={onSave} className="flex flex-col gap-3">
        <input type="hidden" name="businessId" value={creds.businessId} />
        <input type="hidden" name="provider" value="lumaprints" />
        <Input
          label="Username"
          name="username"
          placeholder={creds.lumaprints.hasUsername ? "Set - leave blank to keep" : "Provided after registration"}
          autoComplete="off"
        />
        <Input
          label="Password"
          name="password"
          type="password"
          placeholder={creds.lumaprints.hasPassword ? "Set - leave blank to keep" : ""}
          autoComplete="off"
        />
        <Input
          label="Store ID"
          name="storeId"
          defaultValue={creds.lumaprints.storeId ?? ""}
          placeholder="e.g. 818"
          autoComplete="off"
        />
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            name="sandbox"
            checked={sandbox}
            onChange={(e) => setSandbox(e.currentTarget.checked)}
            className="size-4 rounded border-line accent-pigment"
          />
          Use sandbox (us.api-sandbox.lumaprints.com)
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" loading={pending} disabled={pending}>
            Save
          </Button>
          {connected && (
            <Button type="button" size="sm" variant="secondary" loading={clearing} disabled={clearing} onClick={onClear}>
              Remove
            </Button>
          )}
        </div>
      </form>
    </DataPanel>
  );
}
