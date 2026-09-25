import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { TOUR_STEPS, stepWhat } from "@/lib/tour/steps";
import { GUIDE_ANSWERS } from "@/lib/tour/guide";
import { cn } from "@/lib/utils";
import { DataPanel, Disclosure, Page, PageHeader } from "@/components/ui";
import { Check } from "@/components/ui/icons";
import { PointMeButton, ShowMeAroundButton } from "@/components/tour/show-me-around";

export const dynamic = "force-dynamic";

/**
 * Quick guide: one calm screen. The tour's steps, each with "Point me to
 * it" to open that page with the step lit (the person does it), and the
 * common questions folded away underneath.
 */
export default async function HelpPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  const { onboarding } = await loadShellData(user);
  const steps = TOUR_STEPS[user.role];
  const answers = GUIDE_ANSWERS[user.role];
  const seenUpTo = onboarding?.completedAt ? steps.length : onboarding?.startedAt ? (onboarding.lastStep ?? 0) + 1 : 0;

  return (
    <Page className="max-w-2xl">
      <PageHeader title="Quick guide" description="Point me to it opens the page and rings what to press." actions={<ShowMeAroundButton />} />

      <DataPanel>
        <ol className="divide-y divide-line/70" data-tour-guide="">
          {steps.map((step, i) => {
            const done = i < seenUpTo;
            return (
              <li key={step.id} className="flex items-center gap-3 px-4 py-2.5">
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    done ? "bg-sage text-surface" : "bg-canvas text-slate",
                  )}
                  aria-hidden="true"
                >
                  {done ? <Check size={14} /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">
                    {step.title}
                    <span className="sr-only">{done ? ", seen in the tour" : ", not seen yet"}</span>
                  </p>
                  <p className="text-sm text-pretty text-slate">{stepWhat(step)}</p>
                </div>
                <PointMeButton step={i} title={step.title} />
              </li>
            );
          })}
        </ol>
      </DataPanel>

      <Disclosure summary="Common questions" hint={`${answers.length} answers`}>
        <dl className="flex flex-col gap-4">
          {answers.map((item) => (
            <div key={item.q}>
              <dt className="text-sm font-semibold text-ink">{item.q}</dt>
              <dd className="mt-1 text-sm text-slate">{item.a}</dd>
            </div>
          ))}
        </dl>
      </Disclosure>
    </Page>
  );
}
