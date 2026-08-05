import { redirect } from "next/navigation";
import Link from "next/link";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { getOutbox } from "@/lib/email/outbox";
import { OutboxItemCard } from "@/components/queue/outbox-item";
import { EmptyState, Page, PageHeader } from "@/components/ui";
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
    <Page>
      <PageHeader
        title="Outbox"
        description="Customer emails waiting for VA approval."
        actions={
          <Link
            href="/queue"
            className="inline-flex h-10 items-center rounded-input px-3 text-sm font-medium text-pigment transition-colors hover:bg-pigment-soft"
          >
            Back to queue
          </Link>
        }
      />
      <p className="max-w-2xl text-sm text-slate">
        Review, edit if needed, then send. Automatic photo requests and reminders
        do not appear here.
      </p>

      {items.length === 0 ? (
        <div className="rounded-card border border-line bg-surface shadow-sm">
          <EmptyState
            icon={Inbox}
            headline="Nothing to approve"
            body="New proof-ready emails will land here for review."
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((item) => (
            <OutboxItemCard key={item.messageId} item={item} />
          ))}
        </div>
      )}
    </Page>
  );
}
