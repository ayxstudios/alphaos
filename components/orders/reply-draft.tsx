"use client";

import { useEffect, useState, useTransition } from "react";

import { generateReplyDraft, markReplySent } from "@/app/(app)/orders/[id]/reply-actions";
import { REPLY_TEMPLATE_OPTIONS, type ReplyTemplateChoice } from "@/lib/orders/reply-draft";
import { Button, Select, Textarea, useToast } from "@/components/ui";
import { Copy } from "@/components/ui/icons";

export function ReplyDraft({ orderId, defaultTemplate }: { orderId: string; defaultTemplate: ReplyTemplateChoice }) {
  const toast = useToast();
  const [template, setTemplate] = useState<ReplyTemplateChoice>(defaultTemplate);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, startLoad] = useTransition();
  const [sending, startSend] = useTransition();

  function load(key: ReplyTemplateChoice) {
    setTemplate(key);
    setSent(false);
    startLoad(async () => {
      const res = await generateReplyDraft(orderId, key);
      if (!res.ok) {
        toast({ variant: "danger", title: "Could not draft a reply", description: res.message });
        return;
      }
      setSubject(res.subject);
      setBody(res.body);
    });
  }

  // Load the smart default the first time the panel appears.
  useEffect(() => {
    load(defaultTemplate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      toast({ variant: "success", title: "Copied", description: "Paste it into Etsy (or wherever the customer replies)." });
    } catch {
      toast({ variant: "danger", title: "Could not copy", description: "Select the text and copy it by hand." });
    }
  }

  function markSent() {
    startSend(async () => {
      const res = await markReplySent(orderId, subject, body);
      if (!res.ok) {
        toast({ variant: "danger", title: "Not recorded", description: res.message });
        return;
      }
      setSent(true);
      toast({ variant: "success", title: "Marked as sent" });
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Select
        label="Start from"
        value={template}
        onChange={(e) => load(e.currentTarget.value as ReplyTemplateChoice)}
      >
        {REPLY_TEMPLATE_OPTIONS.map((opt) => (
          <option key={opt.key} value={opt.key}>
            {opt.label}
          </option>
        ))}
      </Select>
      <Textarea
        label="Message"
        value={body}
        onChange={(e) => {
          setBody(e.currentTarget.value);
          setSent(false);
        }}
        rows={8}
        disabled={loading}
        hint="Edit freely before copying. This never sends anything by itself."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={copy} disabled={!body.trim()}>
          <Copy size={15} />
          Copy message
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={sending}
          disabled={!body.trim() || sent}
          onClick={markSent}
        >
          {sent ? "Marked as sent" : "Mark as sent"}
        </Button>
      </div>
    </div>
  );
}
