// Test helper: point the Alpha hook at a fake host for the length of fn and
// record every event push sendAlphaEvent makes, so "a dry run messages nobody"
// is a counted fact rather than a guess. Nothing leaves the machine: a fetch
// stub answers the fake host and passes every other request to the real fetch.
// Added with the dry-run push hold (lib/alpha/client.ts withAlphaPushesHeld,
// clean slating P6, 2026-10-16).
export type AlphaPush = { id?: string; type?: string; toUserId?: string | null; orderId?: string | null };

const HOOK = "https://alpha-hook.test";

export async function recordAlphaPushes<T>(fn: () => Promise<T>): Promise<{ out: T; pushed: AlphaPush[] }> {
  const saved = { url: process.env.ALPHA_HOOK_URL, secret: process.env.ALPHA_HOOK_SECRET };
  const realFetch = globalThis.fetch;
  const pushed: AlphaPush[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(HOOK)) return realFetch(input, init);
    if (url === `${HOOK}/alpha/event`) pushed.push(JSON.parse(String(init?.body ?? "{}")) as AlphaPush);
    return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  process.env.ALPHA_HOOK_URL = HOOK;
  process.env.ALPHA_HOOK_SECRET = "alpha-hook-recorder";
  try {
    const out = await fn();
    return { out, pushed };
  } finally {
    globalThis.fetch = realFetch;
    restore("ALPHA_HOOK_URL", saved.url);
    restore("ALPHA_HOOK_SECRET", saved.secret);
  }
}

function restore(key: "ALPHA_HOOK_URL" | "ALPHA_HOOK_SECRET", value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
