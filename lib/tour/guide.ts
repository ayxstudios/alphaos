import type { Role } from "@/lib/auth/config";

/**
 * Quick guide answers (/help). Each one is drawn from how the app really
 * behaves: the order flow in lib/orders/transitions.ts, the QC screen
 * (components/qc), Messages (components/emails) and docs/PROGRESS.md.
 * Plain English, second person, no internal names.
 */
export type GuideAnswer = { q: string; a: string };

const CUSTOMER_REPLIED: GuideAnswer = {
  q: "A customer replied, what do I do?",
  a: "Replies that match an order show on that order. Anything under Needs you in Messages could not be matched: open it, pick the suggested order or search for the right one, and link it. Then answer from the order. If they are replying to their proof, record whether they approved it or asked for changes; nothing moves until a person confirms.",
};

const NEEDS_DETAILS: GuideAnswer = {
  q: "An order says Needs details",
  a: "It came in from the shop without everything a designer needs. In Orders, open the Needs details tab and press Details on the order. Fill in how many people or pets, the style and the photos, then save. With photos it goes to a designer straight away; without them it waits for the customer's photos.",
};

const PASS_FAIL: GuideAnswer = {
  q: "How do I pass or fail QC?",
  a: "Open QC and press Start QC. Compare the portrait with the customer's photos, tick every item on the checklist, and type your name to unlock the buttons. Pass shows you the email to the customer before it goes. Fail asks which items were wrong and why, then sends it back to the designer.",
};

const UPLOAD_STAFF: GuideAnswer = {
  q: "Where do I upload the finished portrait?",
  a: "The designer uploads it on the order card on their board, while the order is In Design. It then comes to QC. You can see every version on the QC screen; the newest is shown first.",
};

const AWAITING_APPROVAL: GuideAnswer = {
  q: "What does Awaiting approval mean?",
  a: "The portrait passed QC and the customer has been emailed a link to see it. It waits there until they approve it or ask for changes. Changes send it back to the designer; an approved printed order then shows up in Print, and a digital one can be finished.",
};

const LATE: GuideAnswer = {
  q: "An order is late, what should I do?",
  a: "The Overdue tab in Orders lists them, most overdue first. Open the order to see who has it and what it is waiting for. If the designer cannot finish in time, give it to someone else from the order page; the customer's due date stays the same.",
};

const PRINT: GuideAnswer = {
  q: "How do I send an order to print?",
  a: "Approved printed orders wait in Print, oldest first. Place the order with the print company on their own site, then press Sent to print here. When the tracking number arrives, add it on the same row so the order shows as shipped.",
};

const ROSTER: GuideAnswer = {
  q: "How are new orders shared out?",
  a: "New orders go down the Designer Roster from the top, only to designers who do that portrait style, and never past a designer's daily limit. Change the order, styles or limits on the Designer Roster page. The same page adds designers, VAs and admins, resets passwords, and deactivates anyone who leaves (they drop off the list and their history stays).",
};

const DESIGNER: GuideAnswer[] = [
  {
    q: "Where do I upload the finished portrait?",
    a: "Open the card on My Board and tap Start if it is new. Then tap the Finished portrait area and choose the file (on a laptop you can drop it there). Every version is kept; QC checks the newest.",
  },
  {
    q: "How do I send my work to QC?",
    a: "Once the portrait is added, press Submit for QC, in the card or under it on My Board. On a laptop you can also drag the card to Awaiting QC.",
  },
  {
    q: "My portrait came back. What now?",
    a: "It moves to Failed QC or Revisions, and the card shows what to change at the top. Add a new version with the changes, then submit it for QC again.",
  },
  {
    q: "What does With the Customer mean?",
    a: "Your portrait passed QC and the customer has a link to see it. There is nothing to do unless they ask for changes; then it comes back to you under Revisions.",
  },
  {
    q: "I started an order by mistake",
    a: "On a laptop, drag it back to My Queue. That also works for a card sent to Awaiting QC too early, until QC checks it. On a phone, ask your VA to move it back.",
  },
  {
    q: "Where do I see what I have earned?",
    a: "Home and My Week show this week and this month. My Board also has an Earnings history list at the bottom.",
  },
];

export const GUIDE_ANSWERS: Record<Role, GuideAnswer[]> = {
  va: [CUSTOMER_REPLIED, NEEDS_DETAILS, PASS_FAIL, UPLOAD_STAFF, AWAITING_APPROVAL, LATE, PRINT],
  admin: [CUSTOMER_REPLIED, NEEDS_DETAILS, PASS_FAIL, UPLOAD_STAFF, AWAITING_APPROVAL, LATE, PRINT, ROSTER],
  designer: DESIGNER,
};
