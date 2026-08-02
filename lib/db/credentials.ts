import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { eq } from "drizzle-orm";

import type { Tx } from "./index";
import { businesses, shops } from "./schema";

/**
 * Per-shop credential storage.
 *
 * Shop credentials (Etsy keystring + shared secret + OAuth tokens, or a Shopify
 * access token) are stored in a single encrypted `shops.credentials` jsonb blob.
 * The plaintext shape differs per platform, which is why it is jsonb.
 *
 * Encryption is app-layer envelope encryption with AES-256-GCM. The key comes
 * from ENCRYPTION_KEY (64 hex chars = 32 bytes). The decrypted value is never
 * logged or returned anywhere except through getShopCredentials().
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
  }
  return key;
}

/** Ciphertext envelope persisted in shops.credentials. */
type Envelope = {
  v: 1;
  iv: string; // base64
  tag: string; // base64
  data: string; // base64
};

export type ShopCredentials = Record<string, unknown>;

export function encryptCredentials(plaintext: ShopCredentials): Envelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"),
    cipher.final(),
  ]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt(envelope: Envelope): ShopCredentials {
  const decipher = createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as ShopCredentials;
}

/**
 * Decrypt and return a shop's credentials. The ONLY sanctioned way to read the
 * plaintext. Callers must not log or persist the result.
 *
 * Takes a `tx` because `shops` has RLS: run inside withUserContext (admin) or
 * withSystemContext. The raw `db` handle (app_user, no GUC) is blocked by RLS.
 */
export async function getShopCredentials(
  tx: Tx,
  shopId: string,
): Promise<ShopCredentials> {
  const [row] = await tx
    .select({ credentials: shops.credentials })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!row) {
    throw new Error(`Shop not found (or not visible in this context): ${shopId}`);
  }
  return decrypt(row.credentials as Envelope);
}

/** Encrypt and persist a shop's credentials. Requires an admin/system tx. */
export async function setShopCredentials(
  tx: Tx,
  shopId: string,
  credentials: ShopCredentials,
): Promise<void> {
  await tx
    .update(shops)
    .set({ credentials: encryptCredentials(credentials) })
    .where(eq(shops.id, shopId));
}

/**
 * Decrypt and return a business's Gmail OAuth credentials (client id/secret +
 * refresh/access token). Same envelope encryption as shop credentials, keyed on
 * `businesses.gmail_credentials`. Returns `null` when Gmail has never been
 * configured for the business. The ONLY sanctioned way to read the plaintext;
 * callers must not log or persist the result.
 *
 * Takes a `tx` because `businesses` has RLS: run inside withUserContext (admin)
 * or withSystemContext.
 */
export async function getBusinessGmailCredentials(
  tx: Tx,
  businessId: string,
): Promise<ShopCredentials | null> {
  const [row] = await tx
    .select({ gmailCredentials: businesses.gmailCredentials })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!row?.gmailCredentials) return null;
  return decrypt(row.gmailCredentials as Envelope);
}

/** Encrypt and persist a business's Gmail credentials. Requires admin/system tx. */
export async function setBusinessGmailCredentials(
  tx: Tx,
  businessId: string,
  credentials: ShopCredentials,
): Promise<void> {
  await tx
    .update(businesses)
    .set({ gmailCredentials: encryptCredentials(credentials) })
    .where(eq(businesses.id, businessId));
}
