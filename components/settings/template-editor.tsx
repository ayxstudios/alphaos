"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { Button, Input, Textarea, Badge, useToast } from "@/components/ui";
import { ChevronDown } from "@/components/ui/icons";
import { saveEmailTemplate, resetEmailTemplate } from "@/app/(app)/settings/actions";
import {
  fillTemplate,
  sampleTemplateVars,
  unknownPlaceholders,
  type TemplateKey,
} from "@/lib/email/template-meta";

export type TemplateVM = {
  key: string;
  label: string;
  description: string;
  variables: string[];
  subject: string;
  body: string;
  customized: boolean;
};

export function TemplateEditor({
  businessId,
  businessName,
  templates,
}: {
  businessId: string;
  businessName: string;
  templates: TemplateVM[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {templates.map((t) => (
        <TemplateCard key={t.key} businessId={businessId} businessName={businessName} template={t} />
      ))}
    </div>
  );
}

function TemplateCard({
  businessId,
  businessName,
  template,
}: {
  businessId: string;
  businessName: string;
  template: TemplateVM;
}) {
  const toast = useToast();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [showPreview, setShowPreview] = useState(false);
  const [resetting, startReset] = useTransition();
  const [saving, startSave] = useTransition();

  // The saved copy changed (saved here, reset, or edited elsewhere): show it.
  useEffect(() => {
    setSubject(template.subject);
    setBody(template.body);
  }, [template.subject, template.body]);

  const key = template.key as TemplateKey;
  const unknown = useMemo(() => unknownPlaceholders(key, `${subject}\n${body}`), [key, subject, body]);
  const dirty = subject !== template.subject || body !== template.body;
  const preview = useMemo(() => {
    if (!showPreview) return null;
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return fillTemplate({ subject, body }, sampleTemplateVars(businessName, origin));
  }, [showPreview, subject, body, businessName]);

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startSave(async () => {
      try {
        const res = await saveEmailTemplate(form);
        if (res.ok) toast({ variant: "success", title: "Template saved", description: res.message });
        else toast({ variant: "danger", title: "Not saved", description: res.message });
      } catch {
        toast({ variant: "danger", title: "Not saved", description: "Could not save. Try again." });
      }
    });
  }

  function reset() {
    startReset(async () => {
      try {
        const fallback = await resetEmailTemplate(businessId, template.key);
        setSubject(fallback.subject);
        setBody(fallback.body);
        toast({
          variant: "success",
          title: "Back to the default",
          description: `${template.label} uses the built-in text again.`,
        });
      } catch {
        toast({ variant: "danger", title: "Not reset", description: "Could not reset. Try again." });
      }
    });
  }

  return (
    <details className="group rounded-card bg-surface shadow-card">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-3">
        <span className="min-w-0 flex-1 text-sm font-semibold text-ink">{template.label}</span>
        <Badge variant={template.customized ? "info" : "neutral"} dot>
          {template.customized ? "Customized" : "Default"}
        </Badge>
        <ChevronDown size={16} className="text-slate transition-transform group-open:rotate-180" />
      </summary>

      <div className="border-t border-line p-4">
        <p className="mb-3 text-sm text-slate">{template.description}</p>
        <form onSubmit={save} className="flex flex-col gap-3">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="key" value={template.key} />
          <Input
            label="Subject"
            name="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
          />
          <Textarea
            label="Email text"
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            required
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate">Filled in for each customer:</span>
            {template.variables.map((v) => (
              <code key={v} className="rounded bg-canvas px-1.5 py-0.5 text-xs text-pigment">
                {`{{${v}}}`}
              </code>
            ))}
          </div>
          {unknown.length > 0 && (
            <p role="alert" className="text-sm text-rose">
              {unknown.map((u) => `{{${u}}}`).join(", ")} cannot be filled in for this email, so the customer would see a
              blank. Use one of the ones above.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" loading={saving} disabled={resetting || unknown.length > 0}>
              Save template
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? "Hide preview" : "Preview"}
            </Button>
            {template.customized && (
              <Button type="button" variant="ghost" size="sm" loading={resetting} disabled={saving} onClick={reset}>
                Reset to default
              </Button>
            )}
            {dirty && <span className="text-xs text-slate">Not saved yet</span>}
          </div>
          {preview && (
            <div className="rounded-input border border-line bg-canvas/70 p-3" aria-label="Preview with sample details">
              <p className="text-xs text-slate">What a customer called Sam sees, with sample details:</p>
              <p className="mt-2 break-words text-sm font-semibold text-ink">{preview.subject}</p>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink">{preview.body}</p>
            </div>
          )}
        </form>
      </div>
    </details>
  );
}
