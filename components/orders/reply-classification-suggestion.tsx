"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  confirmReplyApproval,
  confirmReplyRevision,
  dismissReplySuggestion,
  type ReplyDecisionResult,
} from "@/app/(app)/orders/actions";
import { Badge, Button, useToast } from "@/components/ui";

type Suggestion = {
  messageId: string;
  intent: "approval" | "revision_request" | "question" | "unclear";
  confidence: number;
  rationale: string;
  strippedText: string;
  decided: boolean;
};

export function ReplyClassificationSuggestion({ suggestion }: { suggestion: Suggestion }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();

  if (suggestion.decided || (suggestion.intent !== "approval" && suggestion.intent !== "revision_request")) {
    return null;
  }

  const approval = suggestion.intent === "approval";
  const pct = Math.round(suggestion.confidence * 100);

  function run(action: () => Promise<ReplyDecisionResult>) {
    start(async () => {
      const res = await action();
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? res.message : "Could not apply suggestion",
        description: res.ok ? undefined : res.message,
      });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="mt-3 rounded-input border border-pigment/20 bg-pigment-soft/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={approval ? "success" : "warning"} dot>
          {approval ? "Likely approval" : "Likely revision"} · {pct}%
        </Badge>
        {suggestion.rationale && <span className="text-xs text-slate">{suggestion.rationale}</span>}
      </div>
      <p className="mt-2 whitespace-pre-wrap rounded-input border border-line bg-surface p-2 text-sm text-ink">
        {suggestion.strippedText || "No new reply text found."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {approval ? (
          <Button
            type="button"
            size="sm"
            loading={pending}
            onClick={() => run(() => confirmReplyApproval(suggestion.messageId))}
          >
            Mark approved
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            loading={pending}
            onClick={() => run(() => confirmReplyRevision(suggestion.messageId))}
          >
            Send back to design
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => dismissReplySuggestion(suggestion.messageId))}
        >
          Dismiss suggestion
        </Button>
      </div>
    </div>
  );
}
