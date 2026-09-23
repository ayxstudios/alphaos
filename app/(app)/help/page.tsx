import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { TOUR_STEPS } from "@/lib/tour/steps";
import { GUIDE_ANSWERS } from "@/lib/tour/guide";
import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { DataPanel, Disclosure, Page, PageHeader, SectionHeader } from "@/components/ui";
import { ArrowRight, Check } from "@/components/ui/icons";
import { ShowMeAroundButton } from "@/components/tour/show-me-around";

export const dynamic = "force-dynamic";

/**
 * Quick guide: one calm page per role. The tour's steps as a checklist
 * (ticked as far as the person got), then short answers to the questions
 * people actually ask.
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
      <PageHeader
        title="Quick guide"
        description="The same steps as the tour, and short answers to common questions."
        actions={<ShowMeAroundButton />}
      />

      <section className="flex flex-col gap-3" aria-labelledby="guide-steps">
        <div id="guide-steps">
          <SectionHeader title="The basics" description={`${steps.length} places, one line each.`} />
        </div>
        <DataPanel>
          <ol className="divide-y divide-line/70">
            {steps.map((step, i) => {
              const done = i < seenUpTo;
              return (
                <li key={step.id} className="flex items-start gap-3 px-4 py-3">
                  <span
                    className={cn(
                      "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
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
                    <p className="mt-0.5 text-sm text-ink">{step.what}</p>
                    <p className="mt-0.5 text-sm text-slate">{step.how}</p>
                  </div>
                  <Link
                    href={step.href}
                    aria-label={`Go to ${step.title}`}
                    className={cn(
                      "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-input px-2 text-sm font-medium text-pigment hover:text-ink lg:min-h-9",
                      focusRing,
                    )}
                  >
                    Go <ArrowRight size={14} />
                  </Link>
                </li>
              );
            })}
          </ol>
        </DataPanel>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="guide-questions">
        <div id="guide-questions">
          <SectionHeader title="Common questions" />
        </div>
        <div className="flex flex-col gap-2">
          {answers.map((item) => (
            <Disclosure key={item.q} summary={item.q}>
              <p className="text-sm text-ink">{item.a}</p>
            </Disclosure>
          ))}
        </div>
      </section>
    </Page>
  );
}
