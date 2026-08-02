import { redirect } from "next/navigation";
import Link from "next/link";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { getOutbox } from "@/lib/email/outbox";
import { OutboxItemCard } from "@/components/queue/outbox-item";
import { Card, EmptyState } from "@/components/ui";
import { Inbox } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default async function OutboxPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const { selected } = await loadShellData(user);
  const items = await getOutbox(user, { businessId: selected.id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-ink">Outbox</h1>
        <Link href="/queue" className="text-sm font-medium text-pigment hover:underline">
          ← Back to queue
        </Link>
      </div>
      <p className="text-sm text-slate">
        Customer emails awaiting approval. Review, edit if needed, then send. Photo
        requests and reminders send automatically and never appear here.
      </p>

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Inbox}
            headline="Nothing to approve"
            body="No drafts are waiting. New proof-ready emails will land here for review."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((item) => (
            <OutboxItemCard key={item.messageId} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
