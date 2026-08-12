"use client";

import { useState, useTransition } from "react";

import { Button, Input, Textarea, Badge } from "@/components/ui";
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
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [resetting, startReset] = useTransition();

  return (
    <details className="group rounded-card border border-line bg-surface shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{template.label}</span>
        <Badge variant={template.customized ? "info" : "neutral"} dot>
          {template.customized ? "Customized" : "Default"}
        </Badge>
        <ChevronDown size={16} className="text-slate transition-transform group-open:rotate-180" />
      </summary>

      <div className="border-t border-line p-4">
        <form action={saveEmailTemplate} className="flex flex-col gap-3">
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
            <Button type="submit" size="sm">
              Save template
            </Button>
            {template.customized && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={resetting}
                onClick={() =>
                  startReset(async () => {
                    await resetEmailTemplate(businessId, template.key);
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
