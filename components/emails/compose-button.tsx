"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Input, Textarea, useToast } from "@/components/ui";
import { Mail, X } from "@/components/ui/icons";
import { sendComposedEmail } from "@/app/(app)/emails/actions";

type ComposeButtonProps = {
  businessId: string;
  to: string;
  subject?: string;
  body?: string;
  orderId?: string | null;
  customerId?: string | null;
  replyToMessageId?: string | null;
  label?: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
};

export function ComposeButton({
  businessId,
  to,
  subject = "",
  body = "",
  orderId = null,
  customerId = null,
  replyToMessageId = null,
  label = "Compose",
  variant = "secondary",
  size = "md",
}: ComposeButtonProps) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState({ to, subject, body });

  function close() {
    if (pending) return;
    setOpen(false);
    setPreview(false);
    setDraft({ to, subject, body });
  }

  // Escape closes the dialog, like every other dialog in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function send() {
    start(async () => {
      const res = await sendComposedEmail({
        businessId,
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        orderId,
        customerId,
        replyToMessageId,
      });
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? res.message ?? "Email sent" : "Couldn't send email",
        description: res.ok ? undefined : res.message,
      });
      if (res.ok) {
        setOpen(false);
        setPreview(false);
        router.refresh();
      }
    });
  }

  return (
    <>
      <Button type="button" variant={variant} size={size} onClick={() => setOpen(true)}>
        <Mail size={15} />
        {label}
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-email-title"
            className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-modal border border-line bg-surface shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <h2 id="compose-email-title" className="text-base font-semibold text-ink">{preview ? "Check and send" : "Write an email"}</h2>
                <p className="text-xs text-slate">{preview ? "This is exactly what the customer gets." : "You see a preview before anything is sent."}</p>
              </div>
              <button
                type="button"
                onClick={close}
                className="-mr-1.5 flex size-11 items-center justify-center rounded-input text-slate hover:bg-canvas hover:text-ink sm:mr-0 sm:size-8"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="max-h-[calc(90vh-8rem)] overflow-y-auto p-4">
              {!preview ? (
                <div className="grid gap-3">
                  <Input
                    label="To"
                    value={draft.to}
                    onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                  />
                  <Input
                    label="Subject"
                    value={draft.subject}
                    onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
                  />
                  <Textarea
                    label="Body"
                    rows={12}
                    value={draft.body}
                    onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                  />
                </div>
              ) : (
                <div className="rounded-card border border-line bg-canvas p-4">
                  <dl className="grid gap-2 text-sm">
                    <div>
                      <dt className="text-xs font-medium text-slate">To</dt>
                      <dd className="text-ink">{draft.to || "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-slate">Subject</dt>
                      <dd className="font-medium text-ink">{draft.subject || "(no subject)"}</dd>
                    </div>
                  </dl>
                  <div className="mt-4 whitespace-pre-wrap rounded-input [overflow-wrap:anywhere] border border-line bg-surface p-3 text-sm text-ink">
                    {draft.body || "(empty)"}
                  </div>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
              {preview ? (
                <>
                  <Button type="button" variant="secondary" onClick={() => setPreview(false)} disabled={pending}>
                    Back to edit
                  </Button>
                  <Button type="button" onClick={send} loading={pending} className="ml-auto">
                    Send email
                  </Button>
                </>
              ) : (
                <>
                  <Button type="button" variant="ghost" onClick={close}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setPreview(true)}
                    className="ml-auto"
                    disabled={!draft.to.trim() || !draft.subject.trim() || !draft.body.trim()}
                  >
                    Preview
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
