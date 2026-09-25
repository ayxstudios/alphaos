// Calm pass: notifications and marketing mail never count as "Needs you",
// while a real person (Etsy buyer, customer on a free mail host) always does.
import { noiseReason } from "../lib/email/noise";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failed++; };
const noise = (name: string, m: Parameters<typeof noiseReason>[0]) => check(`noise: ${name}`, noiseReason(m) !== null, String(noiseReason(m)));
const person = (name: string, m: Parameters<typeof noiseReason>[0]) => check(`person: ${name}`, noiseReason(m) === null, String(noiseReason(m)));

noise("etsy sale notice", { address: "Etsy", subject: "You made a sale on Etsy", channel: "etsy", kind: "sale" });
noise("etsy shipped notice", { address: "Etsy", subject: "Your order shipped", channel: "etsy", kind: "shipped" });
noise("no-reply sender", { address: "Shop <no-reply@example.com>", subject: "Hello", channel: "email" });
noise("shopify mailer", { address: "Shopify <mailer@shopify.com>", subject: "[Shopify] Order #1001 placed", channel: "email" });
noise("etsy transaction mail", { address: "transaction@etsy.com", subject: "Order update", channel: "email" });
noise("mailchimp list", { address: "Brand <brand=example.com@mail12.us4.mcsv.net>", subject: "Our autumn range", channel: "email" });
noise("newsletter mailbox", { address: "newsletter@supplier.com", subject: "September news", channel: "email" });
noise("bounce", { address: "MAILER-DAEMON@googlemail.com", subject: "Delivery Status Notification (Failure)", channel: "email" });
noise("auto reply", { address: "jane@gmail.com", subject: "Automatic reply: Your proof is ready", channel: "email" });
noise("out of office", { address: "jane@gmail.com", subject: "Out of Office: Re: PC32164", channel: "email" });

person("etsy buyer message", { address: "Jane", subject: "Message from Jane about your order", channel: "etsy", kind: "message" });
person("gmail customer", { address: "Jane Doe <jane.doe@gmail.com>", subject: "Re: Your proof for PC32164", channel: "email" });
person("customer with info@ address", { address: "info@janesbakery.com.au", subject: "Question about my portrait", channel: "email" });
person("customer named newton", { address: "newton@outlook.com", subject: "Photos", channel: "email" });
person("reply mentioning a sale", { address: "sam@yahoo.com", subject: "Re: is the sale still on?", channel: "email" });
person("no address", { address: null, subject: null, channel: "email" });

console.log(failed ? `test-email-noise FAILED (${failed})` : "test-email-noise OK");
process.exit(failed ? 1 : 0);
