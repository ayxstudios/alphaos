"use client";

import { useState } from "react";

import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Input,
  Textarea,
  Select,
  StatusChip,
  ORDER_STATUSES,
  Badge,
  Avatar,
  Drawer,
  Skeleton,
  EmptyState,
  Tooltip,
  ToastProvider,
  useToast,
} from "@/components/ui";
import { Plus, Inbox, Info, Search } from "@/components/ui/icons";

/* --- Layout helpers ------------------------------------------------------ */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 scroll-mt-6">
      <div className="flex flex-col gap-1 border-b border-line pb-2">
        <h2 className="font-display text-2xl font-semibold text-ink">{title}</h2>
        {description && <p className="text-sm text-slate">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-slate">
      {children}
    </span>
  );
}

/* --- Token references ---------------------------------------------------- */
const PALETTE = [
  ["canvas", "bg-canvas"],
  ["surface", "bg-surface"],
  ["ink", "bg-ink"],
  ["slate", "bg-slate"],
  ["line", "bg-line"],
  ["pigment", "bg-pigment"],
  ["pigment-soft", "bg-pigment-soft"],
  ["sage", "bg-sage"],
  ["amber", "bg-amber"],
  ["rose", "bg-rose"],
] as const;

const TYPE_SCALE = [
  ["text-4xl", "40px — Display"],
  ["text-2xl", "28px — Display"],
  ["text-lg", "20px — Heading"],
  ["text-base", "16px — Body"],
  ["text-sm", "14px — Small"],
  ["text-xs", "12px — Caption"],
] as const;

/* --- Toast demo (needs to be inside the provider) ------------------------ */
function ToastDemo() {
  const toast = useToast();
  return (
    <Row>
      <Button
        variant="secondary"
        onClick={() =>
          toast({ variant: "info", title: "Order imported", description: "ORD-1042 added to PixArt Etsy." })
        }
      >
        Info toast
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({ variant: "success", title: "Proof approved", description: "Moved to printing." })
        }
      >
        Success toast
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({ variant: "warning", title: "SLA at risk", description: "3 orders due within 2 hours." })
        }
      >
        Warning toast
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast({ variant: "danger", title: "Import failed", description: "Etsy returned 429 — backing off." })
        }
      >
        Danger toast
      </Button>
      <Button
        onClick={() =>
          toast({
            variant: "success",
            title: "Order reassigned to Dana",
            action: { label: "Undo", onClick: () => toast({ variant: "info", title: "Reassignment undone" }) },
          })
        }
      >
        With undo
      </Button>
    </Row>
  );
}

/* --- Page --------------------------------------------------------------- */
function Styleguide() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-12 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-bold text-ink">
          AlphaOS Design System
        </h1>
        <p className="text-base text-slate">
          Every component in every state. Light theme, v1.
        </p>
      </header>

      <Section title="Colour tokens" description="The only colours allowed in any component.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {PALETTE.map(([name, bg]) => (
            <div key={name} className="flex flex-col gap-1.5">
              <div className={`h-14 rounded-card border border-line ${bg}`} />
              <span className="text-xs font-medium text-ink">--{name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Typography" description="Inter for body/UI, Instrument Sans for display headings.">
        <div className="flex flex-col gap-3">
          {TYPE_SCALE.map(([cls, label]) => (
            <div key={cls} className="flex items-baseline gap-4">
              <span className="w-28 shrink-0 text-xs text-slate">{cls}</span>
              <span className={`font-display font-semibold text-ink ${cls}`}>
                {label}
              </span>
            </div>
          ))}
          <p className="max-w-prose text-base text-ink">
            Body copy is set in Inter at 16px. The quick brown fox jumps over the
            lazy dog while 2,000 orders a month flow through fourteen shops.
          </p>
        </div>
      </Section>

      <Section title="Buttons" description="4 variants · 3 sizes · loading & disabled.">
        <div className="flex flex-col gap-3">
          <Row>
            <Label>Primary</Label>
            <Button variant="primary" size="sm">Small</Button>
            <Button variant="primary" size="md">Medium</Button>
            <Button variant="primary" size="lg">Large</Button>
            <Button variant="primary"><Plus size={16} />With icon</Button>
          </Row>
          <Row>
            <Label>Secondary</Label>
            <Button variant="secondary" size="sm">Small</Button>
            <Button variant="secondary" size="md">Medium</Button>
            <Button variant="secondary" size="lg">Large</Button>
          </Row>
          <Row>
            <Label>Ghost</Label>
            <Button variant="ghost" size="sm">Small</Button>
            <Button variant="ghost" size="md">Medium</Button>
            <Button variant="ghost" size="lg">Large</Button>
          </Row>
          <Row>
            <Label>Danger</Label>
            <Button variant="danger" size="sm">Small</Button>
            <Button variant="danger" size="md">Medium</Button>
            <Button variant="danger" size="lg">Large</Button>
          </Row>
          <Row>
            <Label>States</Label>
            <Button loading>Loading</Button>
            <Button variant="secondary" loading>Loading</Button>
            <Button disabled>Disabled</Button>
            <Button variant="secondary" disabled>Disabled</Button>
          </Row>
        </div>
      </Section>

      <Section title="Status chips" description="All 12 order states — colour + text + icon, never colour alone.">
        <Row>
          {ORDER_STATUSES.map((status) => (
            <StatusChip key={status} status={status} />
          ))}
        </Row>
      </Section>

      <Section title="Badges">
        <Row>
          <Badge variant="neutral">Neutral</Badge>
          <Badge variant="info">Info</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="danger">Danger</Badge>
          <Badge variant="info" dot>With dot</Badge>
        </Row>
      </Section>

      <Section title="Form controls" description="Label, hint, and error states.">
        <div className="grid gap-5 sm:grid-cols-2">
          <Input label="Customer first name" placeholder="Alice" hint="Designers only ever see the first name." />
          <Input label="Email" placeholder="you@example.com" error="Enter a valid email address." defaultValue="not-an-email" />
          <Input label="Disabled" placeholder="Unavailable" disabled />
          <Select label="Shop" hint="Pick the shop this order belongs to.">
            <option>PixArt Etsy</option>
            <option>PixArt Shopify</option>
            <option>Lumina Etsy</option>
          </Select>
          <div className="sm:col-span-2">
            <Textarea label="Revision notes" placeholder="Describe the change requested…" hint="Shared with the assigned designer." />
          </div>
          <div className="sm:col-span-2">
            <Textarea label="Rejection reason" error="A reason is required to reject a proof." defaultValue="" />
          </div>
        </div>
      </Section>

      <Section title="Cards" description="Resting shadow (sm); optional hover-lift (md).">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Static card</CardTitle>
              <CardDescription>Resting shadow, no interaction.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate">
                Order ORD-1041 · 2 figures · due in 6 hours.
              </p>
            </CardContent>
            <CardFooter>
              <StatusChip status="in_design" />
            </CardFooter>
          </Card>
          <Card hoverLift className="cursor-pointer">
            <CardHeader>
              <CardTitle>Hover-lift card</CardTitle>
              <CardDescription>Hover to raise (translate + md shadow).</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate">
                Use for clickable board cards and list rows.
              </p>
            </CardContent>
            <CardFooter>
              <StatusChip status="awaiting_qc" />
            </CardFooter>
          </Card>
        </div>
      </Section>

      <Section title="Avatars" description="Initials fallback and image.">
        <Row>
          <Avatar name="Dana Designer" size="sm" />
          <Avatar name="Dana Designer" size="md" />
          <Avatar name="Dana Designer" size="lg" />
          <Avatar name="Val VA" size="md" />
          <Avatar name="A" size="md" />
          <Avatar
            name="With image"
            size="lg"
            src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48' fill='%235B4BC4'/%3E%3Ccircle cx='24' cy='18' r='9' fill='%23EFEDFB'/%3E%3Crect x='8' y='30' width='32' height='18' rx='9' fill='%23EFEDFB'/%3E%3C/svg%3E"
          />
        </Row>
      </Section>

      <Section title="Skeleton" description="Loading placeholders.">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
          <Card>
            <CardContent className="flex flex-col gap-3 p-4">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Empty state">
        <Card>
          <EmptyState
            icon={Inbox}
            headline="No orders to assign"
            body="When new orders finish intake they'll show up here, ready to route to a designer."
            action={<Button><Plus size={16} />Import orders</Button>}
          />
        </Card>
      </Section>

      <Section title="Tooltip" description="Appears on hover and keyboard focus.">
        <Row>
          <Tooltip content="Top tooltip">
            <Button variant="secondary">Hover me (top)</Button>
          </Tooltip>
          <Tooltip content="Bottom tooltip" side="bottom">
            <Button variant="secondary">Bottom</Button>
          </Tooltip>
          <Tooltip content="Search orders" side="right">
            <Button variant="ghost" aria-label="Search"><Search size={16} /></Button>
          </Tooltip>
          <Tooltip content={<span>SLA deadline is fixed at import</span>} side="left">
            <span className="inline-flex items-center gap-1 text-sm text-slate">
              <Info size={15} /> Why is this greyed out?
            </span>
          </Tooltip>
        </Row>
      </Section>

      <Section title="Drawer" description="Slides in from the right.">
        <Button onClick={() => setDrawerOpen(true)}>Open drawer</Button>
        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Order ORD-1041">
          <div className="flex flex-col gap-4">
            <Row>
              <StatusChip status="in_design" />
              <Badge variant="warning" dot>Due soon</Badge>
            </Row>
            <Input label="Customer first name" defaultValue="Alice" />
            <Textarea label="Notes" placeholder="Add a note…" />
            <div className="flex gap-2">
              <Button>Save</Button>
              <Button variant="ghost" onClick={() => setDrawerOpen(false)}>Cancel</Button>
            </div>
          </div>
        </Drawer>
      </Section>

      <Section title="Toasts" description="Bottom-right · auto-dismiss 4s · stacks to 3 · optional undo.">
        <ToastDemo />
      </Section>
    </main>
  );
}

export default function StyleguidePage() {
  return (
    <ToastProvider>
      <Styleguide />
    </ToastProvider>
  );
}
