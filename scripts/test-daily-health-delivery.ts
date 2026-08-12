/**
 * Proves the UTC cron guard keeps the morning briefing at 7am Melbourne time in
 * both standard time and daylight time.
 */
import { shouldRunDailyHealthDeliveryAt } from "../lib/health/delivery";

let failures = 0;

function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const winterSeven = new Date("2026-08-11T21:00:00.000Z"); // 7am AEST on Aug 12
const winterSix = new Date("2026-08-11T20:00:00.000Z");
const summerSeven = new Date("2026-01-11T20:00:00.000Z"); // 7am AEDT on Jan 12
const summerEight = new Date("2026-01-11T21:00:00.000Z");

report("21:00 UTC sends during Melbourne standard time", shouldRunDailyHealthDeliveryAt(winterSeven), winterSeven.toISOString());
report("20:00 UTC skips during Melbourne standard time", !shouldRunDailyHealthDeliveryAt(winterSix), winterSix.toISOString());
report("20:00 UTC sends during Melbourne daylight time", shouldRunDailyHealthDeliveryAt(summerSeven), summerSeven.toISOString());
report("21:00 UTC skips during Melbourne daylight time", !shouldRunDailyHealthDeliveryAt(summerEight), summerEight.toISOString());

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
