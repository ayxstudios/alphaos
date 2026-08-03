"use client";

import { useState, useTransition } from "react";
import Link from "next/link";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Textarea,
  Badge,
} from "@/components/ui";
import { approveAndSend, discardDraft } from "@/app/(app)/queue/outbox/actions";
import type { OutboxItem } from "@/lib/email/outbox";

export function OutboxItemCard({ item }: { item: OutboxItem }) {
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.body);
  const [sending, startSend] = useTransition();
  const [discarding, startDiscard] = useTransition();
  const [error, setError] = useState<string | null>(item.error);
  const [done, setDone] = useState<"sent" | "discarded" | null>(null);

  if (done === "sent") {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-sage">
          Sent to {item.toAddress}.
        </CardContent>
      </Card>
    );
  }
  if (done === "discarded") return null;

  function onSend() {
    setError(null);
    startSend(async () => {
      const res = await approveAndSend({ messageId: item.messageId, subject, body });
      if (res.ok) setDone("sent");
      else setError(res.message);
    });
  }

  function onDiscard() {
    setError(null);
    startDiscard(async () => {
      const res = await discardDraft(item.messageId);
      if (res.ok) setDone("discarded");
      else setError(res.message);
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {item.templateLabel ?? "Email"}
            {item.status === "failed" ? (
              <Badge variant="danger" dot>Failed</Badge>
            ) : (
              <Badge variant="warning" dot>Draft</Badge>
            )}
          </CardTitle>
          {item.orderId && item.orderNumber && (
            <Link href={`/orders/${item.orderId}`} className="text-sm font-medium text-pigment hover:underline">
              Order {item.orderNumber} →
            </Link>
          )}
        </div>
        <p className="text-sm text-slate">
          To {item.customerName ? `${item.customerName} · ` : ""}
          <span className="text-ink">{item.toAddress ?? "no address"}</span>
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <Textarea label="Body" value={body} onChange={(e) => setBody(e.target.value)} rows={9} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onSend} loading={sending} disabled={!item.toAddress}>
              Approve &amp; send
            </Button>
            <Button variant="ghost" size="sm" onClick={onDiscard} loading={discarding}>
              Discard
            </Button>
          </div>
          {error && <p className="text-sm text-rose">{error}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
