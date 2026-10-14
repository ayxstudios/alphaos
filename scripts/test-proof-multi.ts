// A proof for an order of 2+ portraits carries every portrait (Yousif
// 2026-10-14, 4199589633: a dog and a cat bought as one line with quantity 2;
// the dog was uploaded but only the cat ever showed). Checked: the send is
// refused while a portrait has no file; with both files the email carries
// both, numbered by portrait, and the proof page shows each one, pinned to the
// exact file that was sent; a set too big for one email is refused before
// anything goes out (an Etsy-message proof is a link, so no cap there); a
// one-portrait order sends exactly as before.
// Local bench only (scripts/ci-local.sh): creates orders marked "pmulti-" and
// removes them at the end.
import "./load-env";
import { setTestSession } from "./ci/next-request-stub";

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";

import { withSystemContext, type RequestUser } from "../lib/db";
import { ownerReject } from "../app/(app)/approve/actions";
import { assets, assignments, autoQcChecks, businesses, customers, exceptions, messages, orderItems, orders, proofs, qcChecks, shops, users } from "../lib/db/schema";
import { installMockTransport } from "../lib/mock/transport";
import { getDesignerBoard } from "../lib/orders/board-data";
import { getCardDetail } from "../lib/orders/card-detail";
import { getProofImageSource, getProofView } from "../lib/proofs/data";
import { getQcContext } from "../lib/qc/data";
import { ownerApproveCore } from "../lib/qc/owner-approve";
import { listAutoQcJobs } from "../lib/qc/auto-qc-jobs";
import { PreconditionError, runTransition } from "../lib/orders/transitions";
import { MAX_PROOF_EMAILS, splitProofEmails } from "../lib/email/attachments";

const MARK = "pmulti-";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** What a "-big" file reports on HEAD: two of them are more than one email may carry. */
const BIG = 13 * 1024 * 1024;
const HUGE = 25 * 1024 * 1024;

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

type Q = Parameters<Parameters<typeof withSystemContext>[0]>[0];
const q = <T>(fn: (tx: Q) => Promise<T>) => withSystemContext(fn);

/** The decoded RFC 822 text of a Gmail send request, whichever upload form the client used. */
function rawMessage(body: unknown): string {
  const text =
    typeof body === "string"
      ? body
      : body instanceof Uint8Array || body instanceof ArrayBuffer
        ? Buffer.from(body as Uint8Array).toString("utf8")
        : "";
  try {
    const raw = (JSON.parse(text) as { raw?: string }).raw;
    if (raw) return Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    // not JSON: the media upload sends the message itself
  }
  return text;
}

/** The attachment filenames a raw message carries. */
const attachedNames = (raw: string) => [...raw.matchAll(/filename="([^"]+)"/g)].map((m) => m[1]);

async function main() {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.log("skip: local bench only (run it through scripts/ci-local.sh)");
    process.exit(0);
  }

  installMockTransport();
  // Serve the portrait files (example.test) and keep every Gmail send, so what
  // the customer would get is read off the wire, not assumed.
  const sent: string[] = [];
  const inner = globalThis.fetch;
  const png = Buffer.from(PNG, "base64");
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://example.test/")) {
      const head = (init?.method ?? (input instanceof Request ? input.method : "GET")) === "HEAD";
      const length = head && url.includes("-huge") ? HUGE : head && url.includes("-big") ? BIG : png.length;
      return Promise.resolve(
        new Response(head ? null : png, { headers: { "content-type": "image/png", "content-length": String(length) } }),
      );
    }
    if (url.includes("gmail.googleapis.com") && url.includes("/messages/send")) sent.push(rawMessage(init?.body));
    return inner(input, init);
  }) as typeof fetch;

  const [etsy] = await q((tx) =>
    tx
      .select({ shopId: shops.id, businessId: shops.businessId })
      .from(shops)
      .innerJoin(businesses, eq(businesses.id, shops.businessId))
      .where(and(eq(shops.platform, "etsy"), eq(businesses.emailSendingEnabled, true)))
      .limit(1),
  );
  if (!etsy) throw new Error("seed has no Etsy shop on a business with email sending on");
  const businessId = etsy.businessId;
  const [va] = await q((tx) =>
    tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, "va"), eq(users.active, true))).limit(1),
  );
  if (!va?.name) throw new Error("seed needs a named VA");
  const vaUser: RequestUser = { id: va.id, role: "va" };
  setTestSession({ user: { id: va.id, role: "va", name: va.name } });

  const stamp = Date.now();
  const orderIds: string[] = [];
  const customerIds: string[] = [];

  /**
   * An order in awaiting QC with one line bought `quantity` times and the
   * given uploads. A file's unit is the portrait it is tagged to; "line" =
   * tagged to the line with no unit, exactly how 4199589633's files were
   * stored; all files share one upload time, as they did there.
   */
  async function newOrder(
    tag: string,
    opts: { email: boolean; quantity: number; files: { name: string; unit: number | "line" | null }[] },
  ) {
    return q(async (tx) => {
      const [c] = await tx
        .insert(customers)
        .values({ businessId, email: opts.email ? `${MARK}${tag}-${stamp}@example.test` : "", firstName: "Kel", lastName: `${MARK}${stamp}` })
        .returning({ id: customers.id });
      customerIds.push(c.id);
      const name = `${MARK}${tag}-${stamp}`;
      const [o] = await tx
        .insert(orders)
        .values({
          businessId,
          shopId: etsy.shopId,
          customerId: c.id,
          platformOrderId: name,
          platformOrderName: name,
          status: "awaiting_qc",
          source: "manual",
          uploadToken: randomUUID(),
        })
        .returning({ id: orders.id });
      orderIds.push(o.id);
      const [item] = await tx
        .insert(orderItems)
        .values({
          businessId,
          orderId: o.id,
          title: "Custom Watercolor Pet Portrait",
          variation: "Number Of Pets: 1",
          quantity: opts.quantity,
          style: "cartoon",
          figureCount: 1,
          figureCountSource: "manual",
          productType: "digital",
        })
        .returning({ id: orderItems.id });
      const at = new Date(Date.now() - 60_000);
      const files = await tx
        .insert(assets)
        .values(
          opts.files.map((f) => ({
            businessId,
            orderId: o.id,
            type: "submission" as const,
            storage: "cdn" as const,
            url: `https://example.test/${name}-${f.name}.png`,
            orderItemId: f.unit == null ? null : item.id,
            portraitUnit: typeof f.unit === "number" ? f.unit : null,
            createdAt: at,
          })),
        )
        .returning({ id: assets.id, url: assets.url });
      return { id: o.id, number: name, itemId: item.id, files };
    });
  }

  const outbound = (orderId: string) =>
    q((tx) =>
      tx
        .select({
          channel: messages.channel,
          status: messages.status,
          subject: messages.subject,
          proofId: messages.proofId,
          metadata: messages.metadata,
          error: messages.error,
          attachmentAssetId: messages.attachmentAssetId,
          attachmentFilename: messages.attachmentFilename,
        })
        .from(messages)
        .where(and(eq(messages.orderId, orderId), eq(messages.direction, "outbound")))
        .orderBy(desc(messages.createdAt)),
    );
  const statusOf = (orderId: string) =>
    q((tx) => tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).then((r) => r[0]?.status));
  const proofOf = (proofId: string) =>
    q((tx) => tx.select({ token: proofs.token, files: proofs.files }).from(proofs).where(eq(proofs.id, proofId)).then((r) => r[0]));
  const proofFilesOf = (m: unknown) =>
    ((m ?? {}) as { proofFiles?: { assetId: string; n: number; filename: string }[] }).proofFiles;

  try {
    // 1. Portrait 2 has no file yet: nothing goes out, the order stays in QC.
    const a = await newOrder("gap", { email: true, quantity: 2, files: [{ name: "dog", unit: 1 }] });
    const sends0 = sent.length;
    const ra = await ownerApproveCore(vaUser, va.name, a.id);
    check("a missing portrait is refused", !ra.ok && /Portrait 2/.test(ra.message), ra.ok ? "sent!" : ra.message);
    check("the order stays in awaiting QC", (await statusOf(a.id)) === "awaiting_qc");
    check("no message and no email", (await outbound(a.id)).length === 0 && sent.length === sends0);

    // 2. The 4199589633 shape: both files on the line, no unit, one upload time.
    const b = await newOrder("both", { email: true, quantity: 2, files: [{ name: "dog", unit: "line" }, { name: "cat", unit: "line" }] });
    // A pre-slot Auto QC looked only at the cat even though both files were
    // already uploaded. Time alone must not make that check current.
    await q((tx) => tx.insert(autoQcChecks).values({
      businessId, orderId: b.id, assetIds: [b.files[1].id], verdict: "pass",
      portraits: [], createdAt: new Date(),
    }));
    const recheck = (await listAutoQcJobs({ limit: 1000 })).find((job) => job.orderId === b.id);
    check("an old cat-only check requeues both existing portraits", !!recheck && recheck.assetIds.length === 2);
    const sends1 = sent.length;
    const rb = await ownerApproveCore(vaUser, va.name, b.id);
    check("with both portraits it sends", rb.ok && rb.delivery === "email", rb.ok ? `${rb.title}` : rb.message);
    const bm = (await outbound(b.id))[0];
    check("the email went out once", bm?.status === "sent" && sent.length === sends1 + 1, `${bm?.status} ${bm?.error ?? ""} sends=${sent.length - sends1}`);
    const names = attachedNames(sent[sent.length - 1] ?? "");
    check(
      "the email carries both portraits, numbered",
      names.length === 2 && /-portrait-1\.png$/.test(names[0] ?? "") && /-portrait-2\.png$/.test(names[1] ?? ""),
      names.join(", "),
    );
    const listed = proofFilesOf(bm?.metadata) ?? [];
    check(
      "the message lists both files in portrait order",
      listed.length === 2 && listed.map((f) => f.n).join() === "1,2" && new Set(listed.map((f) => f.assetId)).size === 2 &&
        listed.every((f) => b.files.some((x) => x.id === f.assetId)),
      JSON.stringify(listed.map((f) => f.n)),
    );
    const pb = bm?.proofId ? await proofOf(bm.proofId) : undefined;
    check(
      "the proof is pinned to exactly those files",
      pb?.files?.length === 2 && pb.files.map((f) => f.assetId).join() === listed.map((f) => f.assetId).join() && pb.files.map((f) => f.n).join() === "1,2",
    );
    const view = pb ? await getProofView(pb.token) : null;
    check(
      "the proof page shows each portrait",
      view?.portraits.length === 2 && view.portraits.every((p) => p.hasPreview) && view.portraits.map((p) => p.n).join() === "1,2",
      JSON.stringify(view?.portraits),
    );
    const url = (f: { assetId: string } | undefined) => b.files.find((x) => x.id === f?.assetId)?.url;
    const p1 = pb ? await getProofImageSource(pb.token, 1) : null;
    const p2 = pb ? await getProofImageSource(pb.token, 2) : null;
    check("portrait 1 on the page is the file sent as portrait 1", !!p1 && p1.url === url(listed[0]), `${p1?.url}`);
    check("portrait 2 on the page is the file sent as portrait 2", !!p2 && p2.url === url(listed[1]), `${p2?.url}`);
    check("there is no portrait 3", pb ? (await getProofImageSource(pb.token, 3)) === null : false);
    // A designer upload after the send is not something the customer was sent.
    await q((tx) =>
      tx.insert(assets).values({
        businessId,
        orderId: b.id,
        type: "submission",
        storage: "cdn",
        url: `https://example.test/${b.number}-newer.png`,
        orderItemId: b.itemId,
        portraitUnit: 2,
      }),
    );
    const p2after = pb ? await getProofImageSource(pb.token, 2) : null;
    check("a newer unchecked upload does not change the sent proof", !!p2after && p2after.url === url(listed[1]), `${p2after?.url}`);

    // 3. Too big for one email (13 + 13 MB): two emails, one portrait each,
    // "(1 of 2)" and "(2 of 2)", the plural wording, the order moves on once.
    const c = await newOrder("big", { email: true, quantity: 2, files: [{ name: "dog-big", unit: 1 }, { name: "cat-big", unit: 2 }] });
    const sends2 = sent.length;
    const rc = await ownerApproveCore(vaUser, va.name, c.id);
    check("a set too big for one email is sent as two", rc.ok && rc.delivery === "email" && /in 2 emails/.test(rc.description ?? ""), rc.ok ? rc.description : rc.message);
    const cm = (await outbound(c.id)).reverse();
    check(
      "two sent emails, (1 of 2) then (2 of 2)",
      cm.length === 2 && cm.every((m) => m.status === "sent") && / \(1 of 2\)$/.test(cm[0].subject ?? "") && / \(2 of 2\)$/.test(cm[1].subject ?? ""),
      cm.map((m) => `${m.status} ${m.subject}`).join(" | "),
    );
    check("the plural wording on both", cm.every((m) => /proofs are ready/.test(m.subject ?? "")), cm.map((m) => m.subject).join(" | "));
    const cNames = sent.slice(sends2).map(attachedNames);
    check(
      "each portrait attached exactly once, in order",
      sent.length === sends2 + 2 && cNames.length === 2 && cNames[0].length === 1 && cNames[1].length === 1 && /-portrait-1\./.test(cNames[0][0]) && /-portrait-2\./.test(cNames[1][0]),
      JSON.stringify(cNames),
    );
    const cMeta = cm.map((m) => (m.metadata ?? {}) as { qcPass?: unknown; proofEmail?: { n: number; of: number } });
    check("only the first email carries the QC pass", !!cMeta[0]?.qcPass && !cMeta[1]?.qcPass && cMeta[1]?.proofEmail?.n === 2 && cMeta[1]?.proofEmail?.of === 2);
    check("one proof, pinned to both portraits", cm[0]?.proofId === cm[1]?.proofId && ((cm[0]?.proofId ? await proofOf(cm[0].proofId) : undefined)?.files?.length ?? 0) === 2);
    check("the order moved on", (await statusOf(c.id)) === "awaiting_approval");

    // 3b. One file over the cap can never go by email: refused, nothing sent.
    const h = await newOrder("over", { email: true, quantity: 2, files: [{ name: "dog", unit: 1 }, { name: "cat-huge", unit: 2 }] });
    const sendsH = sent.length;
    const rh = await ownerApproveCore(vaUser, va.name, h.id);
    check("a single file over the cap is refused", !rh.ok && /Portrait 2 is .* MB, more than one email can carry/.test(rh.message), rh.ok ? "sent!" : rh.message);
    check("nothing went out and it stays in QC", sent.length === sendsH && (await outbound(h.id)).length === 0 && (await statusOf(h.id)) === "awaiting_qc");

    // 3c. More than MAX_PROOF_EMAILS emails' worth: refused, nothing sent.
    const many = await newOrder("many", {
      email: true,
      quantity: 5,
      files: [1, 2, 3, 4, 5].map((n) => ({ name: `p${n}-big`, unit: n })),
    });
    const sendsM = sent.length;
    const rm = await ownerApproveCore(vaUser, va.name, many.id);
    check("a set needing 5 emails is refused", !rm.ok && /more than 4 emails can carry/.test(rm.message), rm.ok ? "sent!" : rm.message);
    check("nothing went out for it", sent.length === sendsM && (await outbound(many.id)).length === 0);

    // 3d. The split itself: consecutive groups in portrait order, each under the cap.
    const mb = (n: number | null, i: number) => ({ i, sizeBytes: n == null ? null : n * 1024 * 1024 });
    const groups = (sizes: (number | null)[]) => splitProofEmails(sizes.map(mb))?.map((g) => g.map((f) => f.i).join("+")).join(" | ") ?? "refused";
    check("fits in one: one email", groups([10, 10]) === "0+1");
    check("10+10+10 MB: two emails, in order", groups([10, 10, 10]) === "0+1 | 2", groups([10, 10, 10]));
    check("an unknown size keeps one email", groups([20, null, 20]) === "0+1+2");
    check("one portrait is never split", groups([30]) === "0");
    check("one file over the cap: refused", groups([5, 25]) === "refused");
    check(`more than ${MAX_PROOF_EMAILS} emails: refused`, groups([20, 20, 20, 20, 20]) === "refused" && groups([20, 20, 20, 20]) === "0 | 1 | 2 | 3");

    // 4. No email on file: the Etsy desk sends the proof link, so size is no limit.
    const d = await newOrder("etsy", { email: false, quantity: 2, files: [{ name: "dog-big", unit: 1 }, { name: "cat-big", unit: 2 }] });
    const sends3 = sent.length;
    const rd = await ownerApproveCore(vaUser, va.name, d.id);
    const dm = (await outbound(d.id))[0];
    check("Etsy delivery queues both portraits", rd.ok && rd.delivery === "etsy" && dm?.channel === "etsy" && (proofFilesOf(dm.metadata)?.length ?? 0) === 2, rd.ok ? `${dm?.channel}` : rd.message);
    check("Gmail is not used for it", sent.length === sends3);
    const pd = dm?.proofId ? await proofOf(dm.proofId) : undefined;
    const dview = pd ? await getProofView(pd.token) : null;
    check("its proof page shows both portraits", dview?.portraits.length === 2 && dview.portraits.every((p) => p.hasPreview));

    // 5. One portrait: exactly today's email.
    const e = await newOrder("one", { email: true, quantity: 1, files: [{ name: "only", unit: null }] });
    const sends4 = sent.length;
    const re = await ownerApproveCore(vaUser, va.name, e.id);
    const em = (await outbound(e.id))[0];
    check("a one-portrait order sends", re.ok && em?.status === "sent" && sent.length === sends4 + 1, re.ok ? `${em?.status} ${em?.error ?? ""}` : re.message);
    const one = attachedNames(sent[sent.length - 1] ?? "");
    check("one attachment, named as before", one.length === 1 && !one[0].includes("-portrait-") && one[0] === em?.attachmentFilename, one.join(", "));
    check("no portrait list on the message", proofFilesOf(em?.metadata) === undefined);
    const pe = em?.proofId ? await proofOf(em.proofId) : undefined;
    const eview = pe ? await getProofView(pe.token) : null;
    check("its proof page is the one-image page", !!eview && eview.portraits.length === 0 && eview.hasPreview);

    // 5b. Sent short, then re-checked (4198299787: the buyer got 1 of 2 before
    // portraits counted). Back to QC through hold, Approve again: the same
    // proof link goes with both portraits and the proof-ready wording, not
    // the "revised portrait" one (the buyer never asked for changes).
    await q(async (tx) => {
      await tx.update(orderItems).set({ quantity: 2 }).where(eq(orderItems.orderId, e.id));
      await tx.update(assets).set({ orderItemId: e.itemId, portraitUnit: 1 }).where(eq(assets.orderId, e.id));
      await tx.insert(assets).values({
        businessId, orderId: e.id, type: "submission", storage: "cdn",
        url: `https://example.test/${e.number}-second.png`, orderItemId: e.itemId, portraitUnit: 2,
        createdAt: new Date(Date.now() - 30_000),
      });
    });
    await q((tx) => runTransition(tx, vaUser, { orderId: e.id, expectedFrom: "awaiting_approval", to: "on_hold", metadata: { reason: "proof sent short" } }));
    await q((tx) => runTransition(tx, vaUser, { orderId: e.id, expectedFrom: "on_hold", to: "awaiting_qc", metadata: { reason: "proof sent short" } }));
    // The live orders were sent hours earlier; outside the 10 minute double-send guard.
    await q((tx) => tx.update(messages).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(messages.orderId, e.id)));
    const sends5 = sent.length;
    const re2 = await ownerApproveCore(vaUser, va.name, e.id);
    const em2 = (await outbound(e.id))[0];
    check("the re-check sends", re2.ok && re2.delivery === "email" && em2?.status === "sent" && sent.length === sends5 + 1, re2.ok ? `${em2?.status}` : re2.message);
    check("same proof link as the first email", !!em2 && em2.proofId === em?.proofId);
    check("proof-ready plural wording, not the revision one", /proofs are ready/.test(em2?.subject ?? ""), em2?.subject ?? "");
    const both = attachedNames(sent[sent.length - 1] ?? "");
    check("both portraits attached this time", both.length === 2 && /-portrait-1\./.test(both[0]) && /-portrait-2\./.test(both[1]), both.join(", "));
    const pe2 = em2?.proofId ? await proofOf(em2.proofId) : undefined;
    check("the proof page now shows both", pe2?.files?.length === 2);

    // 6. The gap order (1) on the owner's and the designer's screens: QC flags
    // portrait 2, the one-tap send back is marked under Count, and the card and
    // the board wait for portrait 2 before Submit for QC shows.
    const [designer] = await q((tx) =>
      tx.select({ id: users.id }).from(users).where(and(eq(users.role, "designer"), eq(users.active, true))).limit(1),
    );
    if (!designer) throw new Error("seed needs an active designer");
    await q((tx) => tx.insert(assignments).values({ businessId, orderId: a.id, designerId: designer.id }));
    const qa = await getQcContext(vaUser, a.id);
    const gap = qa?.proofFiles.mode === "slots" ? qa.proofFiles.missing.map((m) => m.n).join() : "";
    check("QC flags portrait 2 as missing", gap === "2", gap);
    const back = await ownerReject({
      orderId: a.id,
      note: "Portrait 2 of 2 is missing. This order is 2 separate portraits, so please add it and submit again.",
      failedKeys: [],
    });
    check("one tap sends it back to the designer", back.ok && (await statusOf(a.id)) === "in_design", back.ok ? back.title : back.message);
    const countKey = qa?.checklist.items.find((it) => /count/i.test(it.label))?.key;
    const [qcFail] = await q((tx) =>
      tx
        .select({ itemResults: qcChecks.itemResults })
        .from(qcChecks)
        .where(and(eq(qcChecks.orderId, a.id), eq(qcChecks.result, "fail")))
        .orderBy(desc(qcChecks.createdAt))
        .limit(1),
    );
    const marked = (qcFail?.itemResults ?? {}) as Record<string, boolean>;
    check("the send back is marked under Count", countKey != null && marked[String(countKey)] === false, JSON.stringify(marked));

    const upload = (name: string, unit: number) =>
      q((tx) =>
        tx.insert(assets).values({
          businessId,
          orderId: a.id,
          type: "submission",
          storage: "cdn",
          url: `https://example.test/${a.number}-${name}.png`,
          orderItemId: a.itemId,
          portraitUnit: unit,
          createdAt: new Date(Date.now() + 2000),
        }),
      );
    const boardCard = async () => {
      const board = await getDesignerBoard(vaUser, designer.id, businessId, { includeEarnings: false });
      return Object.values(board.columns)
        .flat()
        .find((c) => c.orderId === a.id);
    };
    await upload("dog-v2", 1);
    let card = await getCardDetail(vaUser, a.id);
    check("the card says portrait 2 still needs a file", card.missingPortraits.map((m) => m.n).join() === "2", JSON.stringify(card.missingPortraits));
    check(
      "both dog versions count as portrait 1",
      card.images.filter((i) => i.type === "submission").every((i) => i.portrait === 1),
      card.images.map((i) => `${i.type}:${i.portrait}`).join(" "),
    );
    let refusedMissing = false;
    try {
      await q((tx) => runTransition(tx, vaUser, {
        orderId: a.id, expectedFrom: "in_design", to: "awaiting_qc",
      }));
    } catch (error) {
      refusedMissing = error instanceof PreconditionError && /Portrait 2/.test(error.message);
    }
    check("the transition refuses two dog versions with the cat missing", refusedMissing && (await statusOf(a.id)) === "in_design");
    const early = await boardCard();
    check("the board does not offer Submit for QC yet", !!early && !early.readyForQc, `${early?.status} ${early?.readyForQc}`);
    await upload("cat", 2);
    card = await getCardDetail(vaUser, a.id);
    check("with the cat uploaded nothing is missing", card.missingPortraits.length === 0 && card.images.some((i) => i.portrait === 2));
    const ready = await boardCard();
    check("then the board offers Submit for QC", !!ready?.readyForQc, `${ready?.status} ${ready?.readyForQc}`);
    // 4199589633's own files (tagged to the line, no unit) read as portrait 1 and 2, not both as 1.
    const cb = await getCardDetail(vaUser, b.id);
    const bn = b.files.map((f) => cb.images.find((i) => i.id === f.id)?.portrait);
    check("the line-tagged dog and cat show as portraits 1 and 2 on the card", [...bn].sort().join() === "1,2", bn.join());
  } finally {
    setTestSession(null);
    await q(async (tx) => {
      if (orderIds.length) {
        await tx.delete(exceptions).where(inArray(exceptions.orderId, orderIds));
        // Cascades messages, proofs, items and assets; activity_log keeps its rows.
        await tx.delete(orders).where(inArray(orders.id, orderIds));
      }
      if (customerIds.length) await tx.delete(customers).where(inArray(customers.id, customerIds));
    });
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
