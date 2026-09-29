"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { Badge, Button, Checkbox, DataPanel, Input, Select, useToast } from "@/components/ui";
import { saveAgentSettingsAction } from "@/app/(app)/settings/actions";
import type { AgentSettings, AutoSendTemplateKey } from "@/lib/agent/config";
import type { PrintRoutingOverride, PrintRoutingProvider } from "@/lib/print/routing-types";

export type AgentSettingsVM = AgentSettings & {
  businessName: string;
  templateLabels: Record<AutoSendTemplateKey, string>;
  templateKeys: AutoSendTemplateKey[];
};

const PROVIDER_LABEL: Record<PrintRoutingProvider, string> = { lumaprints: "Lumaprints", gelato: "Gelato" };

const FLAGS = [
  { key: "intake" as const, label: "Intake", help: "Completes Etsy order details, checks photo counts, drafts the photo request for approval, raises exceptions." },
  { key: "assign" as const, label: "Assignment", help: "Assigns ready orders to the best free designer by capacity and style. A human reassignment always wins." },
  { key: "inbox" as const, label: "Inbox", help: "Applies clear approvals and revision requests, drafts answers to questions for approval, escalates anything unclear." },
];

function Card({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <DataPanel className="p-4">
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {help && <p className="mt-1 text-sm text-slate">{help}</p>}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </DataPanel>
  );
}

export function AgentSettingsPanel({ vm }: { vm: AgentSettingsVM }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [flagPending, startFlag] = useTransition();
  const [flags, setFlags] = useState(vm.flags);
  const [channels, setChannels] = useState(vm.channels);
  const [readInbox, setReadInbox] = useState(vm.mailbox.readInbox);
  const [provider, setProvider] = useState<PrintRoutingProvider>(vm.printMix.defaultProvider);
  const [overrides, setOverrides] = useState<PrintRoutingOverride[]>(vm.printMix.overrides);
  const [threshold, setThreshold] = useState(String(Math.round(vm.replyConfidenceThreshold * 100)));
  const [auto, setAuto] = useState<Set<AutoSendTemplateKey>>(new Set(vm.autoSendTemplates));

  const on = FLAGS.filter((f) => flags[f.key]).map((f) => f.label.toLowerCase());
  const thresholdNum = Number(threshold);
  const thresholdBad = !Number.isFinite(thresholdNum) || thresholdNum < 50 || thresholdNum > 100;

  function flip(key: "intake" | "assign" | "inbox") {
    const next = !flags[key];
    setFlags((f) => ({ ...f, [key]: next }));
    startFlag(async () => {
      const res = await saveAgentSettingsAction(vm.businessId, { flags: { [key]: next } });
      if (!res.ok) {
        setFlags((f) => ({ ...f, [key]: !next }));
        toast({ variant: "danger", title: "Could not change the switch", description: res.message });
        return;
      }
      toast({ variant: "success", title: `Agent ${key} ${next ? "on" : "off"}` });
      router.refresh();
    });
  }

  function save() {
    if (thresholdBad) {
      toast({ variant: "danger", title: "Confidence must be 50 to 100" });
      return;
    }
    start(async () => {
      const res = await saveAgentSettingsAction(vm.businessId, {
        channels,
        mailbox: { readInbox, sendFrom: vm.mailbox.sendFrom },
        printMix: { defaultProvider: provider, overrides: overrides.filter((o) => o.productType?.trim() || o.size?.trim()) },
        replyConfidenceThreshold: thresholdNum / 100,
        autoSendTemplates: [...auto],
      });
      toast(res.ok ? { variant: "success", title: "Agent settings saved" } : { variant: "danger", title: "Not saved", description: res.message });
      if (res.ok) router.refresh();
    });
  }

  function setOverride(i: number, patch: Partial<PrintRoutingOverride>) {
    setOverrides((list) => list.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={on.length ? `The agent runs: ${on.join(", ")}` : "The agent is off"}
        help={`For ${vm.businessName}. Switches apply straight away. Nothing goes to a customer without your one-tap approval unless you flip a template below.`}
      >
        {FLAGS.map((f) => (
          <div key={f.key} className="flex flex-wrap items-center gap-2 rounded-input border border-line bg-canvas/70 px-3 py-2.5">
            <span className="text-sm font-medium text-ink">{f.label}</span>
            <Badge variant={flags[f.key] ? "success" : "neutral"} dot>
              {flags[f.key] ? "On" : "Off"}
            </Badge>
            <Button type="button" size="sm" variant="secondary" className="ml-auto" loading={flagPending} onClick={() => flip(f.key)}>
              {flags[f.key] ? "Turn off" : "Turn on"}
            </Button>
            <p className="w-full text-xs text-slate">{f.help}</p>
          </div>
        ))}
        <p className="text-xs text-slate">
          Reply and order-update emails are set up in{" "}
          <Link href="/settings?section=email" className="-my-3 inline-flex min-h-11 items-center underline">
            Customer Email
          </Link>
          .
        </p>
      </Card>

      <Card title="Channels" help="Where the agent picks up orders. Follows your connected shops until you change it.">
        {(["etsy", "shopify"] as const).map((c) => (
          <label key={c} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-input bg-canvas/70 px-3 py-2">
            <Checkbox checked={channels[c]} onChange={(e) => setChannels((s) => ({ ...s, [c]: e.currentTarget.checked }))} />
            <span className="text-sm font-medium text-ink">{c === "etsy" ? "Etsy" : "Shopify"}</span>
            <span className="text-xs text-slate">{vm.channelDefaults[c] ? "shop connected" : "no active shop"}</span>
          </label>
        ))}
      </Card>

      <Card title="Mailbox" help="The connected Gmail account the agent reads buyer replies from and sends from.">
        <div className="rounded-input bg-canvas/70 px-3 py-2.5 text-sm">
          {vm.mailbox.connectedAddress ? (
            <span className="break-all font-medium text-ink">{vm.mailbox.connectedAddress}</span>
          ) : (
            <span className="text-slate">
              No Gmail connected. Connect one in{" "}
              <Link href="/settings?section=email" className="underline">
                Customer Email
              </Link>
              .
            </span>
          )}
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-input bg-canvas/70 px-3 py-2">
          <Checkbox checked={readInbox} onChange={(e) => setReadInbox(e.currentTarget.checked)} />
          <span className="text-sm font-medium text-ink">Agent reads buyer replies from this mailbox</span>
        </label>
      </Card>

      <Card title="Print mix" help="Which print provider an order goes to. Lumaprints is the default; add an override for a product or size that goes elsewhere.">
        <Select label="Default provider" value={provider} onChange={(e) => setProvider(e.target.value as PrintRoutingProvider)}>
          {(Object.keys(PROVIDER_LABEL) as PrintRoutingProvider[]).map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABEL[p]}
              {p === "lumaprints" ? " (default)" : ""}
            </option>
          ))}
        </Select>
        {overrides.map((o, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-input border border-line bg-canvas/70 p-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <Input label="Product" value={o.productType ?? ""} placeholder="canvas" onChange={(e) => setOverride(i, { productType: e.target.value })} />
              <Input label="Size" value={o.size ?? ""} placeholder="8x10" onChange={(e) => setOverride(i, { size: e.target.value })} />
              <Select label="Goes to" value={o.provider} onChange={(e) => setOverride(i, { provider: e.target.value as PrintRoutingProvider })}>
                {(Object.keys(PROVIDER_LABEL) as PrintRoutingProvider[]).map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABEL[p]}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="button" size="sm" variant="secondary" className="w-fit" onClick={() => setOverrides((l) => l.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="w-fit"
          onClick={() => setOverrides((l) => [...l, { productType: "", provider: provider === "gelato" ? "lumaprints" : "gelato" }])}
        >
          Add an override
        </Button>
      </Card>

      <Card title="Confidence bar" help="How sure the agent must be before it acts on a buyer reply by itself. Below this it asks you.">
        <div className="max-w-40">
          <Input
            label="Percent (50 to 100)"
            type="number"
            inputMode="numeric"
            min={50}
            max={100}
            value={threshold}
            error={thresholdBad ? "Enter 50 to 100" : undefined}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </div>
      </Card>

      <Card title="Automatic send" help="Every email is a draft for one-tap approval by default. Tick a template to let the agent send it without asking. Nothing sends while customer email sending is off.">
        {vm.templateKeys.map((k) => {
          const isAuto = auto.has(k);
          return (
            <label key={k} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-input bg-canvas/70 px-3 py-2">
              <Checkbox
                checked={isAuto}
                onChange={(e) =>
                  setAuto((s) => {
                    const n = new Set(s);
                    if (e.currentTarget.checked) n.add(k);
                    else n.delete(k);
                    return n;
                  })
                }
              />
              <span className="min-w-0 flex-1 text-sm font-medium text-ink">{vm.templateLabels[k]}</span>
              <Badge variant={isAuto ? "warning" : "neutral"}>{isAuto ? "Automatic" : "Draft for approval"}</Badge>
            </label>
          );
        })}
      </Card>

      <div className="sticky bottom-20 z-10 lg:static">
        <Button type="button" className="w-full sm:w-auto" loading={pending} onClick={save}>
          Save agent settings
        </Button>
      </div>
    </div>
  );
}
