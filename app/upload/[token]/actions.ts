"use server";

import { headers } from "next/headers";

import { checkRateLimit, clientIp } from "@/lib/proofs/rate-limit";
import {
  presignCustomerUploads,
  saveCustomerUploads,
  type FileMeta,
  type PresignResult,
  type SaveResult,
} from "@/lib/uploads/data";

/**
 * Rate-limit guard for the public upload actions, same shape as the proof
 * portal's: limited by BOTH the client IP and the token, so one link can't be
 * hammered and one host can't sweep many links.
 */
async function guard(action: string, token: string, limit: number, windowSec: number): Promise<string | null> {
  const ip = clientIp(await headers());
  const [byIp, byToken] = await Promise.all([
    checkRateLimit(`upload:${action}:ip:${ip}`, limit, windowSec),
    checkRateLimit(`upload:${action}:tok:${token}`, limit, windowSec),
  ]);
  if (!byIp.ok || !byToken.ok) return "Too many attempts. Please wait a moment and try again.";
  return null;
}

export async function presignAction(token: string, files: FileMeta[]): Promise<PresignResult> {
  const blocked = await guard("presign", token, 30, 60);
  if (blocked) return { ok: false, message: blocked };
  return presignCustomerUploads(token, files);
}

export async function saveAction(token: string, keys: string[], note: string): Promise<SaveResult> {
  const blocked = await guard("save", token, 20, 60);
  if (blocked) return { ok: false, message: blocked };
  return saveCustomerUploads(token, keys, note);
}
