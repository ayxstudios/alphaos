"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, useToast } from "@/components/ui";
import { OrderCard } from "./order-card";
import { moveOrder } from "@/app/(app)/board/actions";
import type { BoardCard } from "@/lib/orders/board-data";
import type { OrderStatus } from "@/lib/orders/transitions";

export function QueueCard({
  card,
  actions,
}: {
  card: BoardCard;
  actions: { to: OrderStatus; label: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  function go(to: OrderStatus) {
    start(async () => {
      const res = await moveOrder(card.orderId, to, card.status);
      if (!res.ok) {
        toast({
          variant: "danger",
          title: res.code === "stale" ? "Already moved" : "Action failed",
          description: res.message,
        });
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <OrderCard card={card} />
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button key={a.to} size="sm" variant="secondary" loading={pending} onClick={() => go(a.to)}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
