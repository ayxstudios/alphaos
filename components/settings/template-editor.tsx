"use client";

import { useEffect, useState, useTransition } from "react";

import { Button, Input, Textarea, Badge, useToast } from "@/components/ui";
import { ChevronDown } from "@/components/ui/icons";
import { saveEmailTemplate, resetEmailTemplate } from "@/app/(app)/settings/actions";

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
  templates,
}: {
  businessId: string;
  templates: TemplateVM[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {templates.map((t) => (
        <TemplateCard key={t.key} businessId={businessId} template={t} />
      ))}
    </div>
  );
}

function TemplateCard({ businessId, template }: { businessId: string; template: TemplateVM }) {
  const toast = useToast();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [resetting, startReset] = useTransition();
  const [saving, startSave] = useTransition();

  // The saved copy changed (saved here, reset, or edited elsewhere): show it.
  useEffect(() => {
    setSubject(template.subject);
    setBody(template.body);
  }, [template.subject, template.body]);

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startSave(async () => {
      try {
        await saveEmailTemplate(form);
        toast({ variant: "success", title: "Template saved", description: `Customers get this ${template.label.toLowerCase()} email from now on.` });
      } catch {
        toast({ variant: "danger", title: "Didn't save", description: "The subject and body both need some text." });
      }
    });
  }

  return (
    <details className="group rounded-card bg-surface shadow-card">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{template.label}</span>
        <Badge variant={template.customized ? "info" : "neutral"} dot>
          {template.customized ? "Customized" : "Default"}
        </Badge>
        <ChevronDown size={16} className="text-slate transition-transform group-open:rotate-180" />
      </summary>

      <div className="border-t border-line p-4">
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
            label="Body"
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            required
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate">Variables</span>
            {template.variables.map((v) => (
              <code key={v} className="rounded bg-canvas px-1.5 py-0.5 text-xs text-pigment">
                {`{{${v}}}`}
              </code>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" loading={saving} disabled={resetting}>
              Save template
            </Button>
            {template.customized && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={resetting}
                disabled={saving}
                onClick={() =>
                  startReset(async () => {
                    const fallback = await resetEmailTemplate(businessId, template.key);
                    setSubject(fallback.subject);
                    setBody(fallback.body);
                    toast({
                      variant: "success",
                      title: "Back to the default",
                      description: `${template.label} uses the built-in text again.`,
                    });
                  })
                }
              >
                Reset to default
              </Button>
            )}
          </div>
        </form>
      </div>
    </details>
  );
}
