/**
 * Security QA round 2 (docs/QA-2026-09-23-security-r2.md) regression checks:
 *
 *  - per-IP failed-login limit next to the per-email lockout (lib/auth/login.ts):
 *    a password spray from one IP across many emails locks that IP, other IPs
 *    and header-less callers are unaffected, the window rolls over
 *  - "Pass QC and send": a second send for the same proof is refused while the
 *    first is in flight (lib/qc/send-guard.ts), and the sign-off + checklist
 *    gate runs before the email leaves (assertQcPassAllowed)
 *
 * Runs against the seeded local database (scripts/ci-local.sh). Everything it
 * creates is removed at the end.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import { loginAttempts, messages, orders, proofs, rateLimits, users } from "../lib/db/schema";
import { AccountLockedError, IP_MAX_FAILED, authenticate, loginClientIp } from "../lib/auth/login";
import { hashPassword } from "../lib/auth/password";
import { PreconditionError, assertQcPassAllowed } from "../lib/orders/transitions";
import { QC_SEND_DEDUPE_MS, qcPassEmailInFlight } from "../lib/qc/send-guard";

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

async function main() {
  await loginIpLimit();
  await qcSendGuard();
  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
