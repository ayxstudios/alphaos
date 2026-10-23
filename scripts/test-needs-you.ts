// Needs you (lib/agent/needs-you.ts): which road each open row takes. Pure, no
// database (the passes are checked in test-limbo.ts). The cases are real rows
// from the owner message of 2026-10-17, then the traps the rules must not fall into.
import {
  AGENT_DAILY_RETAKE_HOURS,
  AGENT_MAX_TAKES,
  AGENT_PICKUP_HOURS,
  AGENT_RETAKE_HOURS,
  AGENT_STALLED_HOURS,
  agentFallback,
  agentStateOf,
  isOwnerTag,
  ownerKindsOf,
  ownWords,
  reactionOnly,
  roadOf,
  takeable,
  thanksOnly,
  type NeedsYouRow,
} from "../lib/agent/needs-you";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const HOUR = 3_600_000;
const now = new Date("2026-10-17T06:00:00Z");
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);

const reply = (said: string, o: Partial<NeedsYouRow> = {}): NeedsYouRow => ({
  kind: "reply_unclear",
  summary: "Buyer reply on order 4190912270 needs a human",
  said,
  orderStatus: "in_design",
  ...o,
});
const roadIs = (name: string, r: NeedsYouRow, road: string, tags: string[] = []) => {
  const got = roadOf(r);
  check(name, got.road === road && got.tags.join() === tags.join(), JSON.stringify(got));
};

// --- The owner message of 2026-10-17, row by row -----------------------------
roadIs(
  "Kris PC32002 (damaged, worst experience): upset + money back, the owner's",
  {
    kind: "legacy_order",
    summary: "Kris's print arrived damaged (no padding in the box) and she calls it her worst experience with us",
    recommendation: "Reprint and reship it with proper padding at our cost, apologise, and claim the damage from the printer",
    said: "After all the time we have waited for this picture, all the delays and all the issues, it shows up damaged due to having ZERO padding to protect it inside the box.",
    orderStatus: "printing",
  },
  "owner",
  ["upset", "refund"],
);
roadIs(
  "Lisa (approved, print not ordered): mine",
  {
    kind: "legacy_order",
    summary: "Lisa approved her revised portrait on 12 Oct ('It's perfect!'); her print has not been ordered yet",
    recommendation: "Order her print now at the cheapest shipping",
    said: "It's perfect! On Mon, Oct 12, 2026 at 9:42 AM <shop@example.test> wrote: > Hi Lisa! > > Thank you for your patience.",
    orderStatus: "awaiting_details",
  },
  "agent",
);
roadIs(
  "Kelly (legacy, 'it has been received'): mine to check, never closed blind",
  {
    kind: "legacy_order",
    summary: "Order not in AlphaOS yet. Check it on Trello, then confirm the details here.",
    said: "Thank you, but it has been received ☺️ *Kelly Thompson* On Thu, Oct 15, 2026, 5:17 AM PixArt Creatives <shop@example.test> wrote:",
    orderStatus: "awaiting_details",
  },
  "agent",
);
roadIs("4190912270 'Awesome, thank you so much!': closed", reply("Awesome, thank you so much! On Wed, Oct 14, 2026 at 9:24 AM PixArt Creatives <shop@example.test> wrote:"), "close");
roadIs(
  "4170595372 'Yes that's fine Can you send express?': mine",
  reply("Yes that’s fine Can you send express? What is the expected delivery time? Sent from Outlook for iOS<https://aka.ms/o0ukef>"),
  "agent",
);
roadIs("PC32152 'Good news indeed. Thank you!' on a proof: mine (it may be a yes)", reply("Good news indeed. Thank you! Yahoo Mail: Search, Organize, Conquer", { orderStatus: "awaiting_approval" }), "agent");
roadIs("the same words off a proof: closed", reply("Good news indeed. Thank you! Yahoo Mail: Search, Organize, Conquer"), "close");
roadIs(
  "PC32130 bounce: mine (fix the address, resend)",
  reply("** Address not found ** Your message wasn't delivered to <email> because the address couldn't be found or is unable to receive email.", { orderStatus: "awaiting_approval" }),
  "agent",
);
roadIs(
  "Adflipr Halloween pitch: mine (ignore the sender)",
  {
    kind: "unmatched_reply",
    summary: "Reply from hello@adflipr.example matches no order",
    recommendation: "If it is not a buyer, press Ignore sender; if it is, attach it to their order.",
    said: "Recover carts. Automate emails. Get Halloween-ready with Adflipr. HALLOWEEN SALES SEASON DON'T LET HALLOWEEN HAUNT YOUR SALES!",
  },
  "agent",
);
roadIs("CPS 4193881065 (a revision nobody holds): the owner's", { kind: "stuck_order", summary: "in design but no designer holds it", reason: "no_designer", revisions: 1 }, "owner", ["revision"]);
roadIs("a first draft nobody holds: mine", { kind: "stuck_order", summary: "in design but no designer holds it", reason: "no_designer", revisions: 0 }, "agent");
roadIs("not assigned ('Give it to Wahyu'): mine", { kind: "stuck_order", summary: "not assigned", reason: "not_assigned", recommendation: "Give it to Wahyu." }, "agent");
roadIs("add-on with no portrait order: mine", { kind: "stuck_order", summary: "add-on (print or extra) with no portrait order linked", reason: "addon_orphan" }, "agent");
roadIs("Perfetta figure count: mine", { kind: "intake_unparsed", summary: "Etsy order #4201436349: could not resolve figure count" }, "agent");
roadIs("missing buyer email: mine", { kind: "intake_unparsed", summary: "Etsy order #4196810764: missing customer email" }, "agent");

// --- Traps -------------------------------------------------------------------
check("a broken link is not damage", ownerKindsOf("The download link is broken, can you resend it?").length === 0);
check("a broken frame is", ownerKindsOf("The frame arrived broken").join() === "refund");
check("a creased print is money back", ownerKindsOf("Hi! The print arrived creased on one corner, can you send a new one?").join() === "refund");
check("'worst case' is not upset", ownerKindsOf("Worst case I can pick it up from the post office").length === 0);
check("'not disappointed at all' is not upset", ownerKindsOf("I'm not disappointed at all, it's lovely").length === 0);
check("a cancellation is money back", ownerKindsOf("I'd like to cancel my order please").join() === "refund");
check("'I will sue' is legal", ownerKindsOf("If this is not fixed I will sue").join() === "legal");
check("an Etsy case is legal", ownerKindsOf("I have opened a case with Etsy").join() === "legal");
check("Sue the person is not a lawsuit", ownerKindsOf("Sue loved it, thank you!").length === 0);
roadIs("Sue's thank-you closes", reply("Sue loved it, thank you!"), "close");
for (const ask of [
  "Is this AI generated?",
  "Did you use AI for this?",
  "Was it drawn by hand or by AI?",
  "is this ai?",
  "This looks like ChatGPT made it",
  "Was this made with Midjourney?",
]) {
  check(`an AI question is the owner's: "${ask}"`, roadOf(reply(ask)).road === "owner" && roadOf(reply(ask)).tags.join() === "upset");
}
check("our own text saying 'AI portrait' is not a buyer asking", roadOf({ kind: "stuck_order", summary: "AI portrait held for an owner's OK", reason: "on_hold" }).road === "agent");
check("Thai, said, maintain are not AI", ownerKindsOf("Said she will maintain it in Thai style").length === 0);
check("a quoted old email is not her words", ownWords("Thanks! On Mon, Oct 12, 2026 at 9:42 AM Shop <a@b.c> wrote: > a refund") === "Thanks!");
check("the history is cut before judging", roadOf(reply("Thanks so much! On Mon, Oct 12, 2026 at 9:42 AM Shop <a@b.c> wrote: > Sorry it arrived damaged")).road === "close");

check("thank-you: 'Thank you so much!! xx Sarah'", thanksOnly("Thank you so much!! xx Sarah"));
check("thank-you: 'Received, thanks! Kind regards, Mary Jones'", thanksOnly("Received, thanks! Kind regards, Mary Jones"));
check("thank-you: 'It arrived today, it's beautiful, thank you'", thanksOnly("It arrived today, it's beautiful, thank you"));
check("not a thank-you: 'Yes, thank you' (an answer)", !thanksOnly("Yes, thank you"));
check("not a thank-you: 'Great, go ahead'", !thanksOnly("Great, go ahead"));
check("not a thank-you: a question", !thanksOnly("Thanks! When will it ship?"));
check("not a thank-you: 'thanks, can you make the ears lighter'", !thanksOnly("Thanks, can you make the ears lighter"));
check("not a thank-you: 'Thank you but the colours are off'", !thanksOnly("Thank you but the colours are off"));
check("not a thank-you: nothing grateful in it", !thanksOnly("Photos attached"));
check("a reaction is nothing to answer", reactionOnly("Jane Doe reacted via Gmail <https://www.google.com/gmail/about/>"));
roadIs("a buyer question with thanks only is never closed as a proof answer", reply("Thank you!", { kind: "buyer_question", orderStatus: "awaiting_approval" }), "agent");
roadIs("only mail rows close: an AI card never does", { kind: "ai_designer_failed", summary: "Order #1: AI could not finish it", said: "Thank you!" }, "agent");

const handed = roadOf(reply("Can you send express?", { ownerAsk: { kinds: ["refund", "nonsense"], note: "Wants express" } }));
check("handed to an owner: the owner's, with valid tags only", handed.road === "owner" && handed.tags.join() === "refund", JSON.stringify(handed));
check("owner tags", isOwnerTag("legal") && isOwnerTag("revision") && !isOwnerTag("invoice"));

// --- When an agent row reaches the owner after all ------------------------------
const fresh = { takes: 0, takenAt: null, note: null };
const created = ago(10);
check("untaken inside grace + pickup: not the owner's", agentFallback(ago(1 + AGENT_PICKUP_HOURS - 0.5), 1, fresh, now) === null);
check("untaken past grace + pickup: the owner hears", agentFallback(ago(1 + AGENT_PICKUP_HOURS + 0.1), 1, fresh, now) === "never picked up");
check("taken an hour ago: still mine", agentFallback(created, 1, { takes: 1, takenAt: ago(1).toISOString(), note: null }, now) === null);
check("taken and dropped: stalled", agentFallback(created, 1, { takes: 1, takenAt: ago(AGENT_STALLED_HOURS).toISOString(), note: null }, now) === "stalled");
check(
  "tried the most times: the owner hears",
  agentFallback(created, 1, { takes: AGENT_MAX_TAKES, takenAt: ago(AGENT_RETAKE_HOURS).toISOString(), note: "x" }, now) === "tried",
);
check("tried the most times, last go still running: mine", agentFallback(created, 1, { takes: AGENT_MAX_TAKES, takenAt: ago(0.5).toISOString(), note: null }, now) === null);
check("takeable: past grace", takeable(ago(2), 1, fresh, now) && !takeable(ago(0.5), 1, fresh, now));
check("takeable: not again inside the retake gap", !takeable(created, 1, { takes: 1, takenAt: ago(1).toISOString(), note: null }, now));
check("takeable: again after it", takeable(created, 1, { takes: 1, takenAt: ago(AGENT_RETAKE_HOURS).toISOString(), note: null }, now));
check("takeable: past the most goes, not again the same day", !takeable(created, 1, { takes: AGENT_MAX_TAKES, takenAt: ago(5).toISOString(), note: null }, now));
check(
  "takeable: past the most goes, one more go a day",
  takeable(created, 1, { takes: AGENT_MAX_TAKES, takenAt: ago(AGENT_DAILY_RETAKE_HOURS).toISOString(), note: null }, now) &&
    takeable(created, 1, { takes: AGENT_MAX_TAKES + 4, takenAt: ago(AGENT_DAILY_RETAKE_HOURS + 1).toISOString(), note: null }, now),
);
const st = agentStateOf({ agentTakes: 2, agentTakenAt: "2026-10-17T01:00:00Z", agentNote: "asked on Etsy" });
check("agent state read from the row", st.takes === 2 && st.takenAt === "2026-10-17T01:00:00Z" && st.note === "asked on Etsy");

console.log(failed ? `\n${failed} check(s) failed` : "\nall needs-you checks passed");
process.exit(failed ? 1 : 0);
