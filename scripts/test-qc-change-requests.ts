// "Changes asked for" on the QC screen: every source (QC fail, customer proof
// revision, customer email, revision note, team note) merged newest first, each
// request shown once, capped, with the rest counted. Pure: no database.
import {
  buildChangeRequests,
  changeRequestHint,
  emptyChangeRequestSources,
  CHANGE_REQUEST_CAP,
  EMAIL_TEXT_CHARS,
  type ChangeRequestSources,
  type QcChangeRequest,
} from "../lib/qc/change-requests";
import { DEFAULT_CHECKLIST, failedLabels } from "../lib/qc/checklist";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failed++; };

const T0 = Date.parse("2026-10-12T01:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const snapshot = { version: 1, items: DEFAULT_CHECKLIST };
const sources = (over: Partial<ChangeRequestSources>): ChangeRequestSources => ({ ...emptyChangeRequestSources(), ...over });
const kinds = (list: QcChangeRequest[]) => list.map((r) => r.kind).join(",");

// A QC fail leaves two rows: the qc_checks row and the activity row. One entry.
const qcFail = { at: at(0), who: "Mia", reason: "Eyes are too dark", checklistSnapshot: snapshot, itemResults: { 1: false, 2: true, 3: true } };
const qcLog = {
  at: at(0.05),
  who: "Shared login",
  action: "order.in_design",
  fromState: "awaiting_qc",
  metadata: { edge: "awaiting_qc->in_design", reason: "Eyes are too dark", failedItems: [DEFAULT_CHECKLIST[0].label], signature: "Mia" },
};

// failedLabels: the shared helper behind the board and this panel.
check("failedLabels keeps only the items marked wrong",
  failedLabels(snapshot, { 1: true, 3: false, 4: false }).join("|") === [DEFAULT_CHECKLIST[2].label, DEFAULT_CHECKLIST[3].label].join("|"));
check("failedLabels is empty with no snapshot or no results",
  failedLabels(null, { 1: false }).length === 0 && failedLabels(snapshot, undefined).length === 0);

{
  const both = buildChangeRequests(sources({ qcFails: [qcFail], activity: [qcLog] }));
  check("a QC fail and its matching activity row show once", both.changeRequests.length === 1 && both.older === 0, kinds(both.changeRequests));
  const only = both.changeRequests[0];
  check("the QC entry has the reason, the failed item as a short chip and the checker's name",
    only?.kind === "qc_send_back" && only.text === "Eyes are too dark" && only.items.join("|") === "Likeness" && only.who === "Mia",
    JSON.stringify(only));

  const logOnly = buildChangeRequests(sources({ activity: [qcLog] })).changeRequests;
  check("the activity row stands in when the QC row is missing, signed by the typed name",
    logOnly.length === 1 && logOnly[0].kind === "qc_send_back" && logOnly[0].who === "Mia" && logOnly[0].items.join("|") === "Likeness" && logOnly[0].text === "Eyes are too dark",
    JSON.stringify(logOnly));

  const later = buildChangeRequests(sources({ qcFails: [qcFail], activity: [{ ...qcLog, at: at(60) }] })).changeRequests;
  check("an activity row with the same words as a QC row is its echo, whatever the clocks say", later.length === 1, kinds(later));
  const other = buildChangeRequests(sources({ qcFails: [qcFail], activity: [{ ...qcLog, at: at(60), metadata: { ...qcLog.metadata, reason: "Collar is wrong" } }] })).changeRequests;
  check("a different send-back hours later is its own entry", other.length === 2 && other[0].text === "Collar is wrong", kinds(other));
}

// Newest first, whatever the source.
{
  const list = buildChangeRequests(sources({
    qcFails: [{ ...qcFail, at: at(10) }],
    proofs: [{ at: at(20), revisionNotes: "Hair not right. Longer fringe", failedItems: ["hair"], annotations: [] }],
    emails: [{ id: "m1", at: at(30), body: "Can the background be blue?" }],
    activity: [{ at: at(40), who: "Ana", action: "comment", fromState: null, metadata: { body: "Check the tattoo" } }],
  })).changeRequests;
  check("newest first across all sources", kinds(list) === "team_note,customer_email,proof_revision,qc_send_back", kinds(list));
}

// A customer email: only what they typed.
{
  const thread = [
    { id: "a", at: at(1), body: "this is perfect! thank you so much" },
    { id: "b", at: at(2), body: "looking closer ... raven (black&white) his color is green ..." },
    { id: "c", at: at(3), body: "i meant his Collar! not color haha. his collar is green" },
  ];
  const list = buildChangeRequests(sources({ emails: thread })).changeRequests;
  check("three customer emails list newest first, who is Customer",
    list.length === 3 && list[0].text.startsWith("i meant his Collar") && list[2].text.startsWith("this is perfect") && list.every((r) => r.kind === "customer_email" && r.who === "Customer"),
    list.map((r) => r.text.slice(0, 12)).join(" | "));

  const skipped = buildChangeRequests(sources({
    emails: [
      { id: "w1", at: at(5), body: "  \n \t  " },
      { id: "w2", at: at(6), body: null },
      { id: "w3", at: at(7), body: "> On Mon, Shop wrote:\n> your proof is ready" },
    ],
  }));
  check("a whitespace-only, empty or all-quoted email is skipped", skipped.changeRequests.length === 0 && skipped.older === 0, kinds(skipped.changeRequests));

  const quoted = buildChangeRequests(sources({
    emails: [{ id: "q", at: at(8), body: "Please make the collar green.\n\nOn Mon, 5 Oct 2026 at 10:00, Shop <shop@example.com> wrote:\n> Your proof is ready\n> Thanks" }],
  })).changeRequests[0];
  check("quoted history is cut off an email", quoted?.text === "Please make the collar green.", JSON.stringify(quoted?.text));

  const long = buildChangeRequests(sources({ emails: [{ id: "l", at: at(9), body: "colour ".repeat(300) }] })).changeRequests[0];
  check("a long email is cut near 600 characters with an ellipsis",
    !!long && long.text.length <= EMAIL_TEXT_CHARS + 1 && long.text.endsWith("…") && long.text.length > EMAIL_TEXT_CHARS * 0.6, String(long?.text.length));

  const twice = buildChangeRequests(sources({ emails: [{ id: "t1", at: at(1), body: "thanks" }, { id: "t2", at: at(2), body: "thanks" }] })).changeRequests;
  check("two emails with the same words are both kept", twice.length === 2);
}

// The customer's proof-page revision: labels as chips, pins counted, text without the label prefix.
{
  const proof = {
    at: at(0),
    revisionNotes: "Wrong eye colour, Hair not right. His collar is green",
    failedItems: ["eye_colour", "hair"],
    annotations: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }],
  };
  const r = buildChangeRequests(sources({ proofs: [proof] })).changeRequests[0];
  check("proof revision: who is Customer, labels and pin count are chips, the note is the customer's own words",
    r?.kind === "proof_revision" && r.who === "Customer" && r.text === "His collar is green" && r.items.join("|") === "Wrong eye colour|Hair not right|2 marks on the image",
    JSON.stringify(r));
  const one = buildChangeRequests(sources({ proofs: [{ ...proof, annotations: [{ x: 0.5, y: 0.5 }] }] })).changeRequests[0];
  check("one pin reads as 1 mark", one?.items.includes("1 mark on the image") === true, JSON.stringify(one?.items));
  const labelsOnly = buildChangeRequests(sources({ proofs: [{ ...proof, revisionNotes: "Wrong eye colour, Hair not right", annotations: null }] })).changeRequests[0];
  check("a revision with only ticked issues keeps the chips and no repeated text", labelsOnly?.text === "" && labelsOnly.items.length === 2, JSON.stringify(labelsOnly));

  const echo = {
    at: at(0.1),
    who: null,
    action: "order.in_design",
    fromState: "awaiting_proof",
    metadata: { via: "proof_portal", revisionReason: "Wrong eye colour, Hair not right. His collar is green", revisionIssues: ["eye_colour", "hair"], annotationCount: 2 },
  };
  const once = buildChangeRequests(sources({ proofs: [proof], activity: [echo] })).changeRequests;
  check("the activity row written with a proof-page revision shows once", once.length === 1 && once[0].kind === "proof_revision", kinds(once));
}

// Revision notes that only live in the activity log, and the ones that echo an email.
{
  const created = {
    at: at(0),
    who: "Ana",
    action: "order.in_design",
    fromState: "ready",
    metadata: { via: "va_created_revision", revisionReason: "Make the background blue" },
  };
  const r = buildChangeRequests(sources({ activity: [created] })).changeRequests[0];
  check("a VA-created revision is a revision note signed by the actor", r?.kind === "revision_note" && r.who === "Ana" && r.text === "Make the background blue", JSON.stringify(r));

  const email = { id: "m9", at: at(5), body: "i meant his Collar! not color haha. his collar is green" };
  const byId = buildChangeRequests(sources({
    emails: [email],
    activity: [{ at: at(5.5), who: null, action: "order.in_design", fromState: "awaiting_proof", metadata: { via: "email_reply", messageId: "m9", revisionReason: "Customer wants the collar green" } }],
  })).changeRequests;
  check("a decision written for an email (same message id) does not repeat it", byId.length === 1 && byId[0].kind === "customer_email", kinds(byId));

  const byText = buildChangeRequests(sources({
    emails: [email],
    activity: [{ at: at(50), who: "Ana", action: "order.in_design", fromState: "awaiting_proof", metadata: { via: "reply_decision", revisionReason: "i meant his Collar! not color haha. his collar is green\n\nOn Mon, Shop wrote:" } }],
  })).changeRequests;
  check("a decision that quotes the email text does not repeat it", byText.length === 1 && byText[0].kind === "customer_email", kinds(byText));

  const short = buildChangeRequests(sources({
    emails: [{ id: "s", at: at(5), body: "ok thanks" }],
    activity: [{ at: at(50), who: "Ana", action: "order.in_design", fromState: "ready", metadata: { revisionReason: "ok" } }],
  })).changeRequests;
  check("a short note is not swallowed by a longer email that happens to contain it", short.length === 2, kinds(short));
}

// Team notes and rows that are not change requests.
{
  const note = buildChangeRequests(sources({ activity: [{ at: at(0), who: "Ana", action: "comment", fromState: null, metadata: { body: "  Check the tattoo on his arm \n" } }] })).changeRequests[0];
  check("a team comment is a team note, trimmed", note?.kind === "team_note" && note.text === "Check the tattoo on his arm" && note.who === "Ana", JSON.stringify(note));

  const nothing = buildChangeRequests(sources({
    activity: [
      { at: at(0), who: "Ana", action: "comment", fromState: null, metadata: { body: "   " } },
      { at: at(1), who: "Ana", action: "order.in_design", fromState: "ready", metadata: { edge: "ready->in_design" } },
      { at: at(2), who: "Ana", action: "order.assigned", fromState: null, metadata: { revisionReason: "not from this action" } },
      { at: new Date("not a date"), who: "Ana", action: "comment", fromState: null, metadata: { body: "bad time" } },
    ],
    qcFails: [{ at: at(3), who: "Mia", reason: null, checklistSnapshot: null, itemResults: null }],
  }));
  check("empty comments, plain starts of work, other actions, bad dates and empty fails are all skipped", nothing.changeRequests.length === 0, kinds(nothing.changeRequests));
}

// The cap and the older count.
{
  const many = Array.from({ length: 13 }, (_, i) => ({ at: at(i), who: "Ana", action: "comment", fromState: null, metadata: { body: `Note ${i + 1}` } }));
  const capped = buildChangeRequests(sources({ activity: many }));
  check("the list is capped at 10 and the rest are counted", CHANGE_REQUEST_CAP === 10 && capped.changeRequests.length === 10 && capped.older === 3, `${capped.changeRequests.length} + ${capped.older}`);
  check("the 10 shown are the newest", capped.changeRequests[0].text === "Note 13" && capped.changeRequests[9].text === "Note 4", `${capped.changeRequests[0].text} .. ${capped.changeRequests[9].text}`);
  const exact = buildChangeRequests(sources({ activity: many.slice(0, 10) }));
  check("exactly 10 means no older line", exact.changeRequests.length === 10 && exact.older === 0);
  const one = buildChangeRequests(sources({ activity: many }), 1);
  check("a smaller cap works the same way", one.changeRequests.length === 1 && one.older === 12);
  check("no sources gives an empty list", buildChangeRequests(emptyChangeRequestSources()).changeRequests.length === 0);
}

// The one-line hint on the Awaiting QC list.
{
  const entry = (kind: QcChangeRequest["kind"], text: string, items: string[] = []): QcChangeRequest => ({ kind, at: at(0).toISOString(), who: "x", text, items });
  check("hint: a customer email starts with Customer:", changeRequestHint(entry("customer_email", "his collar is green")) === "Customer: his collar is green");
  check("hint: a proof-page revision starts with Customer:", changeRequestHint(entry("proof_revision", "Longer fringe")) === "Customer: Longer fringe");
  check("hint: a QC send-back starts with Asked:", changeRequestHint(entry("qc_send_back", "Eyes are too dark")) === "Asked: Eyes are too dark");
  check("hint: a team note starts with Asked:", changeRequestHint(entry("team_note", "Check the tattoo")) === "Asked: Check the tattoo");
  check("hint: chips stand in when there is no text", changeRequestHint(entry("qc_send_back", "", ["Likeness", "Details"])) === "Asked: Likeness, Details");
  check("hint: new lines become spaces", changeRequestHint(entry("revision_note", "one\n\ntwo   three")) === "Asked: one two three");
  const cut = changeRequestHint(entry("customer_email", "word ".repeat(100)), 40);
  check("hint: long text is cut with an ellipsis", !!cut && cut.endsWith("…") && cut.length <= "Customer: ".length + 41, String(cut?.length));
  check("hint: nothing to say gives null", changeRequestHint(null) === null && changeRequestHint(undefined) === null && changeRequestHint(entry("team_note", "  ")) === null);
}

console.log(failed ? `test-qc-change-requests FAILED (${failed})` : "test-qc-change-requests OK");
process.exit(failed ? 1 : 0);
