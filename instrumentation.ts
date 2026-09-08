// Next.js instrumentation hook: runs once per server process before any
// route. With MOCK_INTEGRATIONS=1 the mock transport (lib/mock/transport.ts)
// answers every external API call that presents a mock credential, so the
// whole pipeline runs against convincing fake shops, mailboxes and print
// providers. Real credentials on the same deployment pass straight through.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.MOCK_INTEGRATIONS === "1") {
    const { installMockTransport } = await import("./lib/mock/transport");
    installMockTransport();
  }
}
