# PixArt customer email: templates and rollout switches

Status on 2026-09-23: the PixArt mailbox `admin@pixartcreatives.co` is connected
and polled every 15 minutes. Customer sending is still OFF. The twelve templates
below are saved as PixArt overrides (Settings > Customer email > Email
templates, each shows "Customized"). This file is the review copy; the database
rows are what actually sends. Edit in Settings, then update this file.

## The two switches (flip at rollout, in this order)

Both live on Settings > Customer email > PixArt (open the card by clicking its
header). Only an admin can change them.

1. **Customer email sending: "Turn on"** (`businesses.email_sending_enabled`).
   The master safety rail. While it is OFF nothing reaches a buyer: QC proof
   emails fail with "Email sending is turned OFF", queued emails wait, drafts
   wait. When it is ON:
   - QC "pass and send" emails the proof to the buyer straight away.
   - Queued emails (photo request on import, 48 hour photo reminder, and stage
     emails if switch 2 is on) go out on the next 15 minute flush.
   - Drafts in Messages > Waiting to send still need a person to click
     "Approve & send".
   - **Backlog guard (new):** the moment you turn it on, every unsent system
     email that is now stale is marked **Skipped**: the order is complete,
     delivered, cancelled or archived; or the email waited 7+ days; or it is an
     intake email (order received, photo request, photo reminder) for an order
     placed 7+ days ago. Skipped queued emails become drafts, so the flush never
     sends them. Nothing is deleted: each shows a "Skipped" badge and its reason
     in Messages > Waiting to send, where a VA can still "Approve & send" or
     "Discard". The toast says how many were skipped.
   - On 2026-09-23 PixArt had 22 unsent emails, all "Order received" drafts
     (none queued, so nothing would have auto-sent). Turning on today would mark
     11 of them Skipped (orders placed 7 to 12 days ago) and leave 11 recent ones
     as drafts for a VA to approve or discard.

2. **Stage email auto-send** (`businesses.stage_email_auto_send`, default OFF,
   no Settings toggle yet, set by an admin in the database). Decides whether
   the stage emails (Order received, In the artist's hands, Now printing,
   Shipped, Proof reminder) are created as **drafts** for a VA to approve (OFF)
   or **queued** to send automatically (ON). Leave it OFF for the first days so
   a VA sees every stage email before it goes. Photo request and photo reminder
   always queue (they are the two auto-send exceptions); PixArt's Shopify shop
   has photo requests off (photos come at checkout), and Etsy buyers have no
   email address, so in practice PixArt photo requests are not emailed today.

## What a buyer receives, and when

| Template | Trigger | Sent how |
| --- | --- | --- |
| Photo request | order imported, shop has photo requests on | queued, auto |
| Photo reminder | 48 h after import, still awaiting photos | queued, auto |
| Order received | order imported | draft (auto if switch 2) |
| In the artist's hands | first designer assignment | draft (auto if switch 2) |
| Proof ready (4 variants) | QC pass, picked by digital/physical and figure count | sent by the VA from QC, portrait attached |
| Revision ready | QC pass after a revision round | sent by the VA from QC, portrait attached |
| Proof reminder | 3 days after a proof with no decision | draft (auto if switch 2) |
| Now printing | approved physical order moves to printing | draft (auto if switch 2) |
| Shipped | tracking added | draft (auto if switch 2) |

Physical orders auto-approve 7 days after the proof if the buyer stays silent
(terms); the proof reminder copy says so without promising a date.

## Test sends

Settings > Customer email > Send test mails every template to the address you
type, prefixed `[TEST]`, from the PixArt mailbox, with sample values (Sam
(test), TEST-1001, a sample proof and upload link, a sample tracking number).
It never touches a buyer and never writes to Messages. Test sends carry no
attachment; real proof emails attach the portrait.

## Voice rules used

Warm, short, plain English. Signed "The PixArt Creatives team". No owner names,
no em dashes. One sentence explains each link. Subjects stay under 45
characters so they survive Gmail and phone previews.

## Templates

### Photo request (`photo_request`)

**Subject:** Please send your photos for order {{order_number}}

```text
Hi {{first_name}},

Thank you for your order with PixArt Creatives! We can't wait to start on your portrait.

To begin, we just need your photos. This link opens your own upload page, where you can add them straight from your phone or computer:
{{upload_link}}

Clear, bright photos where faces and eyes are easy to see give the best result.

If you have any questions, just reply to this email.

Warmly,
The PixArt Creatives team
```

### Photo reminder (`photo_reminder`)

**Subject:** Friendly reminder: photos for order {{order_number}}

```text
Hi {{first_name}},

Just a quick nudge: we're ready to start your portrait, but we haven't received your photos yet.

This link opens your upload page, and adding photos takes about a minute:
{{upload_link}}

Already sent them another way? Reply to this email and let us know, and we'll take it from there.

Warmly,
The PixArt Creatives team
```

### Order received (`order_received`)

**Subject:** Thank you for your order, {{first_name}}

```text
Hi {{first_name}},

Thank you for choosing PixArt Creatives! Your order {{order_number}} is in, and we're excited to create something special for you.

Here's what happens next: one of our artists will bring your portrait to life, then we'll email you a proof to review before anything is final.

If there's anything you'd like us to know, just reply to this email.

Warmly,
The PixArt Creatives team
```

### In the artist's hands (`in_design`)

**Subject:** Your portrait is with our artist

```text
Hi {{first_name}},

Good news! Your portrait for order {{order_number}} is now with one of our artists.

We'll email you a proof to review as soon as it's ready. If you think of anything to add in the meantime, just reply to this email.

Warmly,
The PixArt Creatives team
```

### Proof ready, digital, single (`proof_ready_digital_single`)

**Subject:** Your PixArt portrait is ready to review

```text
Hi {{first_name}},

Your portrait for order {{order_number}} is ready, and we hope you love it! The high-resolution file is attached to this email.

This link opens your proof page, where you can approve it in one tap or tell us what you'd like changed:
{{proof_link}}

You can also simply reply to this email with your thoughts.

Would you like it printed? You can add a print here:
https://pixartcreatives.co/products/print-ship

Warmly,
The PixArt Creatives team
```

### Proof ready, digital, multi (`proof_ready_digital_multi`)

**Subject:** Your PixArt portrait is ready to review

```text
Hi {{first_name}},

Your portrait for order {{order_number}} is ready, and we've taken care to capture every face in it. The high-resolution file is attached to this email.

This link opens your proof page, where you can approve it in one tap or tell us what you'd like changed:
{{proof_link}}

You can also simply reply to this email with your thoughts.

Would you like it printed? You can add a print here:
https://pixartcreatives.co/products/print-ship

Warmly,
The PixArt Creatives team
```

### Proof ready, physical, single (`proof_ready_physical_single`)

**Subject:** Your PixArt portrait proof is ready

```text
Hi {{first_name}},

Your portrait proof for order {{order_number}} is ready, and we hope you love it! A preview is attached to this email.

This link opens your proof page, where you can approve it in one tap or tell us what you'd like changed:
{{proof_link}}

Once you approve, we'll send it to print and ship it to you. You can also simply reply to this email with your thoughts.

Warmly,
The PixArt Creatives team
```

### Proof ready, physical, multi (`proof_ready_physical_multi`)

**Subject:** Your PixArt portrait proof is ready

```text
Hi {{first_name}},

Your portrait proof for order {{order_number}} is ready, and we've taken care to capture every face in it. A preview is attached to this email.

This link opens your proof page, where you can approve it in one tap or tell us what you'd like changed:
{{proof_link}}

Once you approve, we'll send it to print and ship it to you. You can also simply reply to this email with your thoughts.

Warmly,
The PixArt Creatives team
```

### Revision ready (`revision_received`)

**Subject:** Your updated PixArt portrait is ready

```text
Hi {{first_name}},

Thank you for your patience! We've made your changes, and the updated portrait for order {{order_number}} is attached.

This link opens your proof page, where you can approve it in one tap or ask for another tweak:
{{proof_link}}

You can also simply reply to this email with your thoughts.

Warmly,
The PixArt Creatives team
```

### Proof reminder (`proof_reminder`)

**Subject:** Your portrait proof is waiting for you

```text
Hi {{first_name}},

Just a friendly reminder that your portrait proof for order {{order_number}} is ready for your review.

This link opens your proof page, where you can approve it in one tap or tell us what you'd like changed:
{{proof_link}}

If we don't hear back within a few days, we'll go ahead with the proof as it is so your order isn't held up. We'd love your feedback first, though!

Warmly,
The PixArt Creatives team
```

### Now printing (`printing`)

**Subject:** Your portrait is being printed

```text
Hi {{first_name}},

Thank you for approving your portrait! Order {{order_number}} is now with our print team.

We'll email you tracking details as soon as it ships.

Warmly,
The PixArt Creatives team
```

### Shipped (`shipped`)

**Subject:** Your PixArt order is on its way

```text
Hi {{first_name}},

Great news, order {{order_number}} has shipped!

Tracking number: {{tracking_number}}
Track your parcel: {{tracking_url}}

Thank you so much for choosing PixArt Creatives. We hope it brings a smile every time you see it.

Warmly,
The PixArt Creatives team
```

## Local test setup (never test against prod)

`.env.local` in the main checkout points at the production database. For
tests and `next dev`, point a worktree's `.env.local` at a local Postgres and
set `NEON_LOCAL_WS_PROXY=127.0.0.1:5488/v1` (lib/db routes the Neon driver
through a plain WebSocket to TCP proxy). `npm run test:send-enable-guard`
refuses to run against a non-local database.
