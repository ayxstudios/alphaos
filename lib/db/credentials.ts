import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "./index";
import { shops } from "./schema";

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
 */
export async function getShopCredentials(
  shopId: string,
): Promise<ShopCredentials> {
  const [row] = await db
    .select({ credentials: shops.credentials })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!row) {
    throw new Error(`Shop not found: ${shopId}`);
  }
  return decrypt(row.credentials as Envelope);
}

/** Encrypt and persist a shop's credentials. */
export async function setShopCredentials(
  shopId: string,
  credentials: ShopCredentials,
): Promise<void> {
  await db
    .update(shops)
    .set({ credentials: encryptCredentials(credentials) })
    .where(eq(shops.id, shopId));
}
