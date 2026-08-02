import { eq, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import {
  getBusinessGmailCredentials,
  setBusinessGmailCredentials,
} from "@/lib/db/credentials";
import { businesses, users, notifications } from "@/lib/db/schema";
import { refreshAccessToken } from "./oauth";
import { GmailApiError, GmailReauthRequiredError, GmailNotConnectedError } from "./errors";
import { buildRawMessage, type OutgoingEmail } from "./mime";
import {
  GMAIL_API_BASE,
  type GmailCredentials,
  type GmailHistoryResponse,
  type GmailMessage,
  type GmailProfile,
  type GmailSendResponse,
} from "./types";

const REFRESH_BUFFER_MS = 120_000; // refresh if <2min to expiry
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gmail API client for one business's own mailbox. Mirrors the Etsy/Shopify
 * clients: on-demand access-token refresh (proactive + reactive on 401) under a
 * row lock so concurrent refreshes serialize, exponential backoff on 429/5xx,
 * and structured logging of every call. Tokens are never logged.
 *
 * Construct via `GmailClient.forBusiness(businessId)`.
 */
export class GmailClient {
  private constructor(
    private readonly businessId: string,
    private creds: GmailCredentials,
  ) {}

  static async forBusiness(businessId: string): Promise<GmailClient> {
    const creds = await withSystemContext((tx) =>
      getBusinessGmailCredentials(tx, businessId),
    );
    if (!creds) throw new GmailNotConnectedError(businessId);
    return new GmailClient(businessId, creds as GmailCredentials);
  }

  get address(): string | undefined {
    return this.creds.address;
  }

  /** Send an email from this business's mailbox. Returns Gmail thread + message ids. */
  async send(
    email: Omit<OutgoingEmail, "from">,
    opts?: { threadId?: string },
  ): Promise<GmailSendResponse> {
    const from = this.creds.address ?? "me";
    const raw = buildRawMessage({ ...email, from });
    const res = await this.api<GmailSendResponse>("POST", "/users/me/messages/send", {
      raw,
      ...(opts?.threadId ? { threadId: opts.threadId } : {}),
    });
    this.log({ event: "email_sent", to: email.to, threadId: res.threadId, messageId: res.id });
    return res;
  }

  getProfile(): Promise<GmailProfile> {
    return this.api<GmailProfile>("GET", "/users/me/profile");
  }

  listHistory(startHistoryId: string, pageToken?: string): Promise<GmailHistoryResponse> {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
    });
    if (pageToken) params.set("pageToken", pageToken);
    return this.api<GmailHistoryResponse>("GET", `/users/me/history?${params.toString()}`);
  }

  getMessage(id: string): Promise<GmailMessage> {
    return this.api<GmailMessage>("GET", `/users/me/messages/${id}?format=full`);
  }

  /* --- HTTP with refresh + backoff + logging ---------------------------- */
  private async api<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    let didReauth = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = await this.ensureAccessToken();
      const start = Date.now();
      const res = await fetch(`${GMAIL_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      this.log({ method, path: path.split("?")[0], status: res.status, ms: Date.now() - start, attempt });

      if (res.ok) return (await res.json()) as T;

      if (res.status === 401 && !didReauth) {
        didReauth = true;
        await this.refresh();
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_ATTEMPTS) {
          throw new GmailApiError(res.status, `Gmail ${method} ${path} failed after ${attempt} attempts`);
        }
        await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
        continue;
      }
      const text = await res.text().catch(() => "");
      throw new GmailApiError(res.status, `Gmail ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    throw new GmailApiError(0, `Gmail ${method} ${path}: exhausted attempts`);
  }

  private tokenValid(): boolean {
    return (
      !!this.creds.accessToken &&
      !!this.creds.accessTokenExpiresAt &&
      new Date(this.creds.accessTokenExpiresAt).getTime() > Date.now() + REFRESH_BUFFER_MS
    );
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.creds.status === "needs_reauth") throw new GmailReauthRequiredError();
    if (this.tokenValid()) return this.creds.accessToken!;
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    return withSystemContext(async (tx) => {
      // Serialize concurrent refreshes on the business row.
      await tx.execute(sql`select id from businesses where id = ${this.businessId} for update`);
      const fresh = (await getBusinessGmailCredentials(tx, this.businessId)) as GmailCredentials | null;
      if (!fresh) throw new GmailNotConnectedError(this.businessId);

      // Another worker may have refreshed while we waited on the lock.
      if (
        fresh.accessToken &&
        fresh.accessTokenExpiresAt &&
        new Date(fresh.accessTokenExpiresAt).getTime() > Date.now() + REFRESH_BUFFER_MS
      ) {
        this.creds = fresh;
        return fresh.accessToken;
      }
      if (!fresh.refreshToken || !fresh.clientId || !fresh.clientSecret) {
        throw new GmailReauthRequiredError("Missing refresh token or client credentials");
      }

      try {
        const tok = await refreshAccessToken({
          clientId: fresh.clientId,
          clientSecret: fresh.clientSecret,
          refreshToken: fresh.refreshToken,
        });
        const updated: GmailCredentials = {
          ...fresh,
          accessToken: tok.access_token,
          accessTokenExpiresAt: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
          // Google only re-issues a refresh token on re-consent; keep the old one otherwise.
          refreshToken: tok.refresh_token ?? fresh.refreshToken,
          status: "connected",
        };
        await setBusinessGmailCredentials(tx, this.businessId, updated);
        this.creds = updated;
        this.log({ event: "token_refreshed" });
        return tok.access_token;
      } catch (err) {
        if (err instanceof GmailReauthRequiredError) {
          await setBusinessGmailCredentials(tx, this.businessId, { ...fresh, status: "needs_reauth" });
          this.creds = { ...fresh, status: "needs_reauth" };
          await this.notifyReauth(tx);
          this.log({ event: "reauth_required", level: "error" });
        }
        throw err;
      }
    });
  }

  private async notifyReauth(tx: Tx): Promise<void> {
    const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
    if (!admins.length) return;
    await tx.insert(notifications).values(
      admins.map((a) => ({
        businessId: this.businessId,
        userId: a.id,
        type: "gmail.reauth_required",
      })),
    );
  }

  private log(extra: Record<string, unknown>): void {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        integration: "gmail",
        businessId: this.businessId,
        ...extra,
      }),
    );
  }
}

/** Persist the sending mailbox address + history cursor after a successful connect. */
export async function markGmailConnected(
  tx: Tx,
  businessId: string,
  opts: { address: string; historyId: string },
): Promise<void> {
  await tx
    .update(businesses)
    .set({ gmailAddress: opts.address, gmailHistoryId: opts.historyId })
    .where(eq(businesses.id, businessId));
}
