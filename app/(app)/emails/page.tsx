import { Suspense } from "react";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { businesses } from "@/lib/db/schema";
import { loadShellData } from "@/lib/shell/context";
import { getIgnoredSenders, getMailHistory, getOutbox, getUnmatchedReplies } from "@/lib/email/outbox";
import { Page, PageHeader } from "@/components/ui";
import { ComposeButton } from "@/components/emails/compose-button";
import { EmailWorkspace } from "@/components/emails/email-workspace";
import { MailHistory, MailHistoryFallback } from "@/components/emails/mail-history";
import { cleanSearchTerm } from "@/lib/search";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  q?: string;
  showSuppressed?: string;
  page?: string;
  pageSize?: string;
}>;

export default async function EmailsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const params = await searchParams;
  const q = cleanSearchTerm(params.q);
  const includeSuppressed = params.showSuppressed === "1";
  const page = Math.max(Number(params.page ?? "1") || 1, 1);
  const pageSizeRaw = Number(params.pageSize ?? "50") || 50;
  const pageSize = pageSizeRaw === 20 || pageSizeRaw === 100 ? pageSizeRaw : 50;

  const { selected } = await loadShellData(user);
  const [emailConfig, unmatched, outbox, ignoredSenders] = await Promise.all([
    withUserContext(user, async (tx) => {
      const [row] = await tx
        .select({
          emailSendingEnabled: businesses.emailSendingEnabled,
          gmailAddress: businesses.gmailAddress,
        })
        .from(businesses)
        .where(eq(businesses.id, selected.id))
        .limit(1);
      return row ?? { emailSendingEnabled: false, gmailAddress: null };
    }),
    getUnmatchedReplies(user, { businessId: selected.id, includeSuppressed: false }),
    getOutbox(user, { businessId: selected.id }),
    getIgnoredSenders(user, { businessId: selected.id }),
  ]);
  const historyOpts = { businessId: selected.id, q, includeSuppressed, page, pageSize };

  return (
    <Page className="max-w-none">
      <PageHeader
        title="Messages"
        description="Customer emails. What needs you is at the top."
        eyebrow={selected.name}
        actions={
          <ComposeButton
            businessId={selected.id}
            to=""
            subject=""
            label="New email"
            variant="primary"
          />
        }
      />
      <EmailWorkspace
        businessId={selected.id}
        sendingEnabled={emailConfig.emailSendingEnabled}
        unmatched={unmatched}
        outbox={outbox}
        history={
          // Its own boundary: "Needs you" paints while the 50-row history
          // query is still running (the page used to wait for all of it).
          <Suspense fallback={<MailHistoryFallback />}>
            <MailHistorySection user={user} {...historyOpts} />
          </Suspense>
        }
        ignoredSenders={ignoredSenders}
      />
    </Page>
  );
}

async function MailHistorySection({
  user,
  businessId,
  q,
  includeSuppressed,
  page,
  pageSize,
}: {
  user: RequestUser;
  businessId: string;
  q: string;
  includeSuppressed: boolean;
  page: number;
  pageSize: number;
}) {
  const history = await getMailHistory(user, { businessId, q, includeSuppressed, page, pageSize });
  return (
    <MailHistory
      businessId={businessId}
      history={history}
      q={q}
      includeSuppressed={includeSuppressed}
      page={page}
      pageSize={pageSize}
    />
  );
}
