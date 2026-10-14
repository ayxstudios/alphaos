// Test-only side-effect module: lets a bench script call server actions
// outside a Next.js request. Import it right after ./load-env and before
// anything that imports @/lib/auth or next/cache.
//   - auth() returns whatever the script set with setTestSession()
//   - revalidatePath / revalidateTag become no-ops (outside Next they throw
//     "static generation store missing")
// Never imported by app code.
import Module, { createRequire } from "node:module";

type TestSession = { user: { id: string; role: string; name?: string | null; email?: string | null } } | null;

let session: TestSession = null;

export function setTestSession(next: TestSession): void {
  session = next;
}

const load = createRequire(__filename);
const authFile = load.resolve("../../lib/auth");
const authStub = new Module(authFile);
authStub.filename = authFile;
authStub.loaded = true;
authStub.exports = {
  auth: async () => session,
  signIn: async () => {
    throw new Error("signIn is not available on the test bench");
  },
  signOut: async () => {},
  handlers: {},
};
load.cache[authFile] = authStub;

const nextCache = load("next/cache") as Record<string, unknown>;
nextCache.revalidatePath = () => {};
nextCache.revalidateTag = () => {};
