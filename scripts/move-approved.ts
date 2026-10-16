// Carry out an owner's yes to move a revision or failed QC to another designer
// (lib/orders/move-approved.ts; the rule: lib/orders/rework.ts).
//
//   npx tsx scripts/move-approved.ts --order <number or id> --to <designer name> \
//     --approved "<who: their words>" [--by "Alpha VA"] [--reason "..."] [--apply]
//
// Without --apply it only says what it would do. Production: DATABASE_URL on
// the owner connection and NEXT_PUBLIC_APP_URL=https://alphaos-kappa.vercel.app
// so the brief links are live.
import "./load-env";

import { moveApproved } from "../lib/orders/move-approved";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
};

moveApproved({
  order: arg("order") ?? "",
  to: arg("to") ?? "",
  approved: arg("approved"),
  by: arg("by") ?? "Alpha VA",
  reason: arg("reason") ?? undefined,
  apply: process.argv.includes("--apply"),
}).then(
  (r) => {
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
