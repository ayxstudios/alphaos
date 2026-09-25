/**
 * Security QA round 2 (docs/QA-2026-09-23-security-r2.md) regression checks:
 *
 *  - per-IP failed-login limit next to the per-email lockout (lib/auth/login.ts):
 *    a password spray from one IP across many emails locks that IP, other IPs
 *    and header-less callers are unaffected, the window rolls over
 *  - "Pass QC and send": a second send for the same proof is refused while the
 *    first is in flight (lib/qc/send-guard.ts), and the sign-off + checklist
 *    gate runs before the email leaves (assertQcPassAllowed)
 *  - outgoing email HTML escapes quotes, so customer text in a URL cannot
 *    break out of the href attribute (textToHtml)
 *  - manual order figure counts are bounded (lib/orders/manual-input.ts)
 *  - mocks never run on the production deployment (lib/mock/guard.ts)
 *  - the Alpha chat widget forwards only an order the caller can see
 *    (lib/alpha/chat-scope.ts)
 *
 *  - customer + security QA 2026-09-25: upload bytes must prove the photo type
 *    (lib/uploads/sniff.ts, lib/uploads/verify.ts), upload keys must belong to
 *    the order, ids are checked before a query (isUuid), and a wrong password
 *    costs the same time for an unknown email as for a real one
 *
 * Runs against the seeded local database (scripts/ci-local.sh). Everything it
 * creates is removed at the end.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import { assignments, loginAttempts, messages, orders, proofs, rateLimits, users } from "../lib/db/schema";
import { scopeChatOrder } from "../lib/alpha/chat-scope";
import { AccountLockedError, IP_MAX_FAILED, authenticate, loginClientIp } from "../lib/auth/login";
import { hashPassword } from "../lib/auth/password";
import { PreconditionError, assertQcPassAllowed } from "../lib/orders/transitions";
import { QC_SEND_DEDUPE_MS, qcPassEmailInFlight } from "../lib/qc/send-guard";
import { textToHtml } from "../lib/integrations/gmail/mime";
import { MAX_FIGURES, parseFigureCount } from "../lib/orders/manual-input";
import { mocksAllowed } from "../lib/mock/guard";
import { secretsMatch } from "../lib/secret-compare";
import { installMockTransport } from "../lib/mock/transport";
import { sniffImageType, sniffMatchesDeclared } from "../lib/uploads/sniff";
import { assertKeysBelongTo, assertStoredImage, referenceUploadProblem } from "../lib/uploads/verify";
import { DEV_STORE_PREFIX, devStorePath, usingDevStore, writeDevStoreObject } from "../lib/uploads/store";
import { isUuid } from "../lib/utils";
import { rm } from "node:fs/promises";
import { isMockMode as gelatoMockMode } from "../lib/integrations/gelato/client";
import { isMockMode as lumaMockMode } from "../lib/integrations/lumaprints/client";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const stamp = Date.now();
const IP_A = "203.0.113.50";
const IP_B = "203.0.113.51";

async function outcome(p: Promise<unknown>): Promise<"user" | "null" | "locked" | string> {
  try {
    const r = await p;
    return r ? "user" : "null";
  } catch (e) {
    return e instanceof AccountLockedError ? "locked" : String(e);
  }
}

async function loginIpLimit() {
  const email = `secr2-ip-${stamp}@example.test`;
  const password = "ip-limit-pass-1234";
  const userId = randomUUID();
  await withSystemContext(async (tx) => {
    await tx.insert(users).values({ id: userId, name: "IP Limit", email, role: "va", passwordHash: await hashPassword(password) });
    await tx.delete(rateLimits).where(inArray(rateLimits.bucket, [`login-ip:${IP_A}`, `login-ip:${IP_B}`]));
  });
  try {
    report(
      "loginClientIp reads the first x-forwarded-for entry, then x-real-ip, else null",
      loginClientIp(new Headers({ "x-forwarded-for": `${IP_A}, 10.0.0.1` })) === IP_A &&
        loginClientIp(new Headers({ "x-real-ip": IP_B })) === IP_B &&
        loginClientIp(new Headers()) === null &&
        loginClientIp(undefined) === null,
      "xff first, x-real-ip fallback, none = no per-IP bucket",
    );

    // Spray: one wrong password each for many different emails, all from IP A.
    for (let i = 0; i < IP_MAX_FAILED; i++) {
      await authenticate(`secr2-spray-${stamp}-${i}@example.test`, "wrong-password", IP_A);
    }
    const [bucket] = await withSystemContext((tx) =>
      tx.select({ hits: rateLimits.hits }).from(rateLimits).where(eq(rateLimits.bucket, `login-ip:${IP_A}`)),
    );
    report(`${IP_MAX_FAILED} failures from one IP are counted`, bucket?.hits === IP_MAX_FAILED, `hits=${bucket?.hits}`);
    report(
      "that IP is locked out, even with the right password for another account",
      (await outcome(authenticate(email, password, IP_A))) === "locked",
      "authenticate(right password, IP A) = AccountLockedError",
    );
    report(
      "another IP signs in normally",
      (await outcome(authenticate(email, password, IP_B))) === "user",
      "authenticate(right password, IP B) = user",
    );
    report(
      "a caller without proxy headers is not throttled by the IP limit",
      (await outcome(authenticate(email, password, null))) === "user",
      "authenticate(ip null) = user",
    );
    report(
      "a success from IP B does not clear IP A",
      (await outcome(authenticate(email, password, IP_A))) === "locked",
      "still locked",
    );
    await withSystemContext((tx) =>
      tx
        .update(rateLimits)
        .set({ windowStart: sql`now() - interval '16 minutes'` })
        .where(eq(rateLimits.bucket, `login-ip:${IP_A}`)),
    );
    report(
      "the IP lock ends when the window rolls over",
      (await outcome(authenticate(email, password, IP_A))) === "user",
      "window_start 16 minutes ago = user",
    );
  } finally {
    await withSystemContext(async (tx) => {
      await tx.delete(users).where(eq(users.id, userId));
      await tx.delete(rateLimits).where(inArray(rateLimits.bucket, [`login-ip:${IP_A}`, `login-ip:${IP_B}`]));
      await tx.delete(loginAttempts).where(like(loginAttempts.email, `secr2-%${stamp}%`));
    });
  }
}

async function qcSendGuard() {
  const ctx = await withSystemContext(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, businessId: orders.businessId, shopId: orders.shopId })
      .from(orders)
      .limit(1);
    const [va] = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.role, "va"), eq(users.active, true)))
      .limit(1);
    return { order, va };
  });
  if (!ctx.order || !ctx.va) {
    report("QC send guard has seed data", false, "no order or VA in the seed");
    return;
  }
  const proofId = randomUUID();
  const msgIds: string[] = [];
  const addMessage = (status: "draft" | "sent" | "failed", createdAt: Date, qcPass = true) =>
    withSystemContext(async (tx) => {
      const id = randomUUID();
      msgIds.push(id);
      await tx.insert(messages).values({
        id,
        businessId: ctx.order.businessId,
        orderId: ctx.order.id,
        direction: "outbound",
        channel: "email",
        status,
        proofId,
        subject: "SECR2 proof",
        body: "SECR2",
        createdAt,
        metadata: qcPass ? { qcPass: { signature: "x" } } : { other: true },
      });
    });
  const inFlight = () =>
    withSystemContext((tx) => qcPassEmailInFlight(tx, { orderId: ctx.order.id, proofId }));
  await withSystemContext((tx) =>
    tx.insert(proofs).values({ id: proofId, businessId: ctx.order.businessId, orderId: ctx.order.id, token: `secr2-${stamp}` }),
  );
  try {
    report("no QC-pass email yet: a send may go", (await inFlight()) === false, "empty");
    await addMessage("failed", new Date());
    await addMessage("sent", new Date(Date.now() - QC_SEND_DEDUPE_MS - 60_000));
    await addMessage("sent", new Date(), false);
    report(
      "a failed send, an old send and a non-QC email do not block a retry",
      (await inFlight()) === false,
      "failed now, sent 11 min ago, non-qcPass sent now",
    );
    await addMessage("draft", new Date());
    report("a QC-pass email drafted just now blocks a second send", (await inFlight()) === true, "draft now");

    const gate = (signature: string, ticked: boolean) =>
      withSystemContext(async (tx) => {
        try {
          await assertQcPassAllowed(tx, { id: ctx.va.id, role: "va" }, { shopId: ctx.order.shopId }, {
            itemResults: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => [k, ticked])),
            signature,
          });
          return "ok";
        } catch (e) {
          return e instanceof PreconditionError ? "refused" : String(e);
        }
      });
    report(
      "pre-send gate: wrong sign-off and unticked checklist are refused, the right ones pass",
      (await gate("Someone Else", true)) === "refused" &&
        (await gate(ctx.va.name ?? "", false)) === "refused" &&
        (await gate(ctx.va.name ?? "", true)) === "ok",
      `va name=${ctx.va.name}`,
    );
  } finally {
    await withSystemContext(async (tx) => {
      if (msgIds.length) await tx.delete(messages).where(inArray(messages.id, msgIds));
      await tx.delete(proofs).where(eq(proofs.id, proofId));
    });
  }
}

function emailHtmlEscaping() {
  const html = textToHtml(`Hi <script>alert(1)</script> https://x.test/"onmouseover="alert(1)\n\nSee https://a.test/p?x=1&y=2 it's ready`);
  const anchors = html.match(/<a [^>]*>/g) ?? [];
  report(
    "email HTML: tags escaped, a quote in a URL cannot leave the href attribute",
    !html.includes("<script>") &&
      anchors.length === 2 &&
      anchors.every((a) => /^<a href="[^"]*">$/.test(a)) &&
      !/"\s*onmouseover=/.test(html) &&
      html.includes('href="https://a.test/p?x=1&amp;y=2"'),
    anchors.join(" "),
  );
  const sentence = textToHtml("Approve it here: https://app.test/proof/AbC_-9. Or reply (https://app.test/upload/x), thanks");
  report(
    "email HTML: a full stop or bracket after a link stays outside the href",
    sentence.includes('href="https://app.test/proof/AbC_-9">') &&
      sentence.includes('href="https://app.test/upload/x">') &&
      !sentence.includes('AbC_-9."') &&
      sentence.includes("overflow-wrap:anywhere"),
    "the default proof template's link opened /proof/<token>. (Link not found) before; long links wrap on a phone",
  );
}

function figureCounts() {
  const v = (raw: unknown) => {
    const r = parseFigureCount(raw);
    return r.ok ? r.value : "refused";
  };
  const cases: [unknown, number | null | "refused"][] = [
    [2, 2], [2.7, 2], [MAX_FIGURES, MAX_FIGURES], [0, null], [-5, null], [null, null], ["3", null],
    [MAX_FIGURES + 1, "refused"], [1_000_000, "refused"], [2_147_483_647, "refused"], [1e10, "refused"], [Infinity, "refused"],
  ];
  const bad = cases.filter(([raw, want]) => v(raw) !== want);
  report(
    `manual order figure count: 1..${MAX_FIGURES} kept, blank/negative = not set, larger refused`,
    bad.length === 0,
    bad.length ? `wrong: ${bad.map(([r]) => String(r)).join(", ")}` : `${cases.length} cases`,
  );
}

function mocksNeverInProduction() {
  const saved = { vercelEnv: process.env.VERCEL_ENV, printMock: process.env.PRINT_PROVIDER_MOCK };
  const realFetch = globalThis.fetch;
  try {
    process.env.VERCEL_ENV = "production";
    process.env.PRINT_PROVIDER_MOCK = "1";
    installMockTransport();
    const transportRefused = globalThis.fetch === realFetch;
    const printRefused =
      !gelatoMockMode({ apiKey: "mock_key" } as Parameters<typeof gelatoMockMode>[0]) &&
      !lumaMockMode({ username: "mock_user", password: "x" } as Parameters<typeof lumaMockMode>[0]);
    process.env.VERCEL_ENV = "preview";
    const previewStillMocks =
      gelatoMockMode({ apiKey: "real-looking-key" } as Parameters<typeof gelatoMockMode>[0]) && mocksAllowed();
    report(
      "mocks never run on production: transport not installed, print clients ignore PRINT_PROVIDER_MOCK and mock_ keys",
      transportRefused && printRefused && previewStillMocks,
      `transport refused=${transportRefused} print refused=${printRefused} preview still mocks=${previewStillMocks}`,
    );
  } finally {
    globalThis.fetch = realFetch;
    if (saved.vercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = saved.vercelEnv;
    if (saved.printMock === undefined) delete process.env.PRINT_PROVIDER_MOCK;
    else process.env.PRINT_PROVIDER_MOCK = saved.printMock;
  }
}

async function alphaChatScope() {
  const pick = await withSystemContext(async (tx) => {
    const [mine] = await tx
      .select({ designerId: assignments.designerId, orderId: assignments.orderId })
      .from(assignments)
      .where(eq(assignments.active, true))
      .limit(1);
    if (!mine) return null;
    const [other] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        sql`not exists (select 1 from assignments a where a.order_id = ${orders.id} and a.designer_id = ${mine.designerId} and a.active)`,
      )
      .limit(1);
    const [va] = await tx.select({ id: users.id }).from(users).where(eq(users.role, "va")).limit(1);
    return other && va ? { ...mine, otherId: other.id, vaId: va.id } : null;
  });
  if (!pick) {
    report("Alpha chat scope has seed data", false, "no assigned + unassigned order pair");
    return;
  }
  const designer = { id: pick.designerId, role: "designer" as const };
  const own = await scopeChatOrder(designer, { orderId: pick.orderId, page: `/orders/${pick.otherId}` });
  const foreign = await scopeChatOrder(designer, { orderId: pick.otherId, page: `/qc/${pick.otherId}` });
  const staff = await scopeChatOrder({ id: pick.vaId, role: "va" }, { orderId: pick.otherId, page: `/orders/${pick.otherId}` });
  report(
    "Alpha chat: a designer's order id reaches the relay only for their own order, hidden ids leave the page path",
    own.orderId === pick.orderId &&
      own.page === "/orders" &&
      foreign.orderId === null &&
      foreign.page === "/qc" &&
      staff.orderId === pick.otherId &&
      staff.page === `/orders/${pick.otherId}`,
    `own=${own.orderId === pick.orderId} foreign=${foreign.orderId} page=${foreign.page} va keeps=${staff.orderId === pick.otherId}`,
  );
}

/** Security QA r1 (P3): cron and Alpha secrets compared in constant time. */
function machineSecrets() {
  const secret = "ci-cron-secret";
  report(
    "machine secrets: exact match only (constant-time compare)",
    secretsMatch(`Bearer ${secret}`, `Bearer ${secret}`) &&
      !secretsMatch(`Bearer ${secret}x`, `Bearer ${secret}`) &&
      !secretsMatch(`Bearer ${secret.slice(0, -1)}`, `Bearer ${secret}`) &&
      !secretsMatch("", `Bearer ${secret}`) &&
      !secretsMatch(null, `Bearer ${secret}`) &&
      !secretsMatch(`Bearer ${secret}`, ""),
    "right secret passes; longer, shorter, empty and missing values fail",
  );
}

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const WEBP_HEAD = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const HEIC_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(4), Buffer.from("mif1heic")]);
const HTML_BYTES = Buffer.from("<!doctype html><script>alert(document.cookie)</script>");
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");

function uploadSniffing() {
  report(
    "upload sniff: real PNG, JPEG, WebP and HEIC headers are recognised",
    sniffImageType(PNG_HEAD) === "image/png" &&
      sniffImageType(JPG_HEAD) === "image/jpeg" &&
      sniffImageType(WEBP_HEAD) === "image/webp" &&
      sniffImageType(HEIC_HEAD) === "image/heic",
    "magic bytes map to the four photo types phones send",
  );
  report(
    "upload sniff: HTML, PDF, empty and mismatched files are refused",
    !sniffMatchesDeclared(HTML_BYTES, "image/png") &&
      !sniffMatchesDeclared(PDF_BYTES, "image/png") &&
      !sniffMatchesDeclared(Buffer.alloc(0), "image/jpeg") &&
      !sniffMatchesDeclared(PNG_HEAD, "image/jpeg") &&
      sniffMatchesDeclared(HEIC_HEAD, "image/heif") &&
      sniffMatchesDeclared(JPG_HEAD, "IMAGE/JPEG"),
    "a .png that is really HTML or a PDF fails; heic and heif are one family; case-insensitive",
  );
  report(
    "ids: isUuid accepts a uuid and refuses anything else",
    isUuid(randomUUID()) && !isUuid("x") && !isUuid("") && !isUuid(null) && !isUuid(`${randomUUID()}'--`),
    "route handlers answer a malformed id before any query",
  );
}

async function uploadKeysAndBytes() {
  if (!usingDevStore()) {
    report("upload verify: stored bytes", false, "R2 is configured; this check needs the local dev store");
    return;
  }
  const biz = randomUUID();
  const order = randomUUID();
  const prefix = `${DEV_STORE_PREFIX}${biz}/${order}/reference/`;
  const good = `${prefix}${randomUUID()}.png`;
  const html = `${prefix}${randomUUID()}.png`;
  const empty = `${prefix}${randomUUID()}.png`;
  try {
    await writeDevStoreObject(good, "image/png", Buffer.concat([PNG_HEAD, Buffer.alloc(64)]));
    await writeDevStoreObject(html, "image/png", HTML_BYTES);
    const refused = async (key: string) => assertStoredImage(key).then(() => false, () => true);
    report(
      "upload verify: a real PNG passes, an HTML file stored as image/png is refused",
      !(await refused(good)) && (await refused(html)) && (await refused(empty)),
      "assertStoredImage reads the first bytes, not the Content-Type the browser sent; a missing file is refused",
    );
    const throws = (fn: () => void) => {
      try {
        fn();
        return false;
      } catch {
        return true;
      }
    };
    report(
      "upload verify: keys must belong to this order",
      !throws(() => assertKeysBelongTo([good], prefix)) &&
        throws(() => assertKeysBelongTo([`${DEV_STORE_PREFIX}${biz}/${randomUUID()}/reference/${randomUUID()}.png`], prefix)) &&
        throws(() => assertKeysBelongTo([`${prefix}../../x.png`], prefix)) &&
        throws(() => assertKeysBelongTo([`${prefix}a/b.png`], prefix)),
      "another order's key, a .. path and a nested path are all refused",
    );
    report(
      "manual order photos: foreign keys, fake photos and non-http links give a plain message",
      (await referenceUploadProblem([good], prefix, ["https://i.etsystatic.com/x.jpg"])) === null &&
        (await referenceUploadProblem([html], prefix)) !== null &&
        (await referenceUploadProblem([], prefix, ["javascript:alert(1)"])) !== null &&
        (await referenceUploadProblem([`${DEV_STORE_PREFIX}${randomUUID()}/${order}/reference/${randomUUID()}.png`], prefix)) !== null,
      "referenceUploadProblem returns null only when every key and link is fine",
    );
  } finally {
    // Only this run's business folder (var/dev-uploads/<biz>), never the store itself.
    await rm(devStorePath(`${DEV_STORE_PREFIX}${biz}/x`).replace(/\/x$/, ""), { recursive: true, force: true }).catch(() => {});
  }
}

async function loginTimingEqual() {
  const email = `cs25-timing-${stamp}@example.test`;
  const userId = randomUUID();
  await withSystemContext(async (tx) => {
    await tx.insert(users).values({ id: userId, name: "Timing", email, role: "va", passwordHash: await hashPassword("timing-pass-1234") });
  });
  try {
    const time = async (e: string) => {
      const t = performance.now();
      await authenticate(e, "wrong-password");
      return performance.now() - t;
    };
    // Warm both paths once (the dummy hash is computed on first use).
    await time(`cs25-nobody-${stamp}@example.test`);
    await time(email);
    let known = 0;
    let unknown = 0;
    for (let i = 0; i < 3; i++) {
      known += await time(email);
      unknown += await time(`cs25-nobody-${stamp}-${i}@example.test`);
    }
    report(
      "login: a wrong password takes as long for an unknown email as for a real one",
      unknown > known * 0.6,
      `3 tries each: real account ${Math.round(known)} ms, unknown email ${Math.round(unknown)} ms (unknown must be > 60% of real)`,
    );
  } finally {
    await withSystemContext(async (tx) => {
      await tx.delete(loginAttempts).where(like(loginAttempts.email, `cs25-%${stamp}%`));
      await tx.delete(users).where(eq(users.id, userId));
    });
  }
}

async function main() {
  machineSecrets();
  await loginIpLimit();
  await alphaChatScope();
  await qcSendGuard();
  emailHtmlEscaping();
  figureCounts();
  mocksNeverInProduction();
  uploadSniffing();
  await uploadKeysAndBytes();
  await loginTimingEqual();
  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
