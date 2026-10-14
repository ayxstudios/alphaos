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
import { assets, businesses, customers, exceptions, messages, orderItems, orders, proofs, shops, users } from "../lib/db/schema";
import { installMockTransport } from "../lib/mock/transport";
import { getProofImageSource, getProofView } from "../lib/proofs/data";
import { ownerApproveCore } from "../lib/qc/owner-approve";

const MARK = "pmulti-";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** What a "-big" file reports on HEAD: two of them are more than one email may carry. */
const BIG = 13 * 1024 * 1024;

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
      const length = head && url.includes("-big") ? BIG : png.length;
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

    // 3. Too big for one email: refused before anything goes out.
    const c = await newOrder("big", { email: true, quantity: 2, files: [{ name: "dog-big", unit: 1 }, { name: "cat-big", unit: 2 }] });
    const sends2 = sent.length;
    const rc = await ownerApproveCore(vaUser, va.name, c.id);
    check("a set too big for one email is refused", !rc.ok && /more than one email can carry/.test(rc.message), rc.ok ? "sent!" : rc.message);
    check("nothing went out and it stays in QC", sent.length === sends2 && (await outbound(c.id)).length === 0 && (await statusOf(c.id)) === "awaiting_qc");

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
