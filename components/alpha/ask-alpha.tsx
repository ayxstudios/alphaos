"use client";

import { useState, useTransition } from "react";

import { askAlphaAboutOrder } from "@/app/(app)/alpha-actions";
import { Button, Textarea } from "@/components/ui";
import { Bot } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

type Answer = { text: string; escalated: boolean; connected: boolean };

/**
 * Ask Alpha: a plain question box. Works on an order card (scoped answer,
 * logged to the order) or on its own in the top bar (general house rules).
 * With no daemon connected, the fallback still renders as a normal answer —
 * never as an error state.
 */
export function AskAlpha({ orderId = null, compact = false }: { orderId?: string | null; compact?: boolean }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function ask() {
    const q = question.trim();
    if (!q) return;
    setError(null);
    start(async () => {
      const res = await askAlphaAboutOrder(orderId, q);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setAnswer({ text: res.answer, escalated: res.escalated, connected: res.connected });
      setQuestion("");
    });
  }

  return (
    <div className={cn("flex flex-col gap-3", compact ? "w-full" : "")}>
      {!compact && (
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Bot size={17} className="text-pigment" />
          Ask Alpha AI
        </div>
      )}
      <Textarea
        value={question}
        onChange={(e) => setQuestion(e.currentTarget.value)}
        placeholder={
          orderId ? "Ask about this order, e.g. \"can I ship this early?\"" : "Ask a question about how we do things"
        }
        rows={compact ? 2 : 3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            ask();
          }
        }}
      />
      <Button type="button" size="sm" className="w-fit" loading={pending} disabled={!question.trim()} onClick={ask}>
        Ask
      </Button>
      {error && <p className="text-sm text-rose">{error}</p>}
      {answer && (
        <div className="rounded-input border border-pigment/20 bg-pigment-soft/40 p-3 text-sm text-ink">
          <p className="whitespace-pre-wrap">{answer.text}</p>
          {orderId && <p className="mt-2 text-xs text-slate">Saved as a note on this order.</p>}
        </div>
      )}
    </div>
  );
}
