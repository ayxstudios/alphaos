import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getEyeData } from "@/lib/eye/data";

import { EyeClient } from "./eye-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "The Eye" };

/** The All Seeing Eye: owner only, outside the app shell. */
export default async function EyePage() {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/eye");
  if (session.user.role === "designer" || session.user.role === "helper") redirect("/board");
  if (session.user.role !== "admin") redirect("/dashboard");

  const data = await getEyeData({ id: session.user.id, role: session.user.role });
  return <EyeClient initial={data} />;
}
