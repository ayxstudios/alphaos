/**
 * Board constants shared between server data-fetching (lib/orders/board-data.ts)
 * and client board components (components/board/*). This file must stay free
 * of any server-only import (db, r2/node:crypto, etc.) — designer-board.tsx and
 * mobile-board.tsx are "use client" and import from here at the VALUE level, so
 * anything this file pulls in gets bundled into the browser.
 */

/** The Complete column only ever shows recent work — older completes belong in Orders/history, not a live board. */
export const COMPLETE_COLUMN_WINDOW_DAYS = 14;
export const COMPLETE_COLUMN_MAX = 40;

/**
 * States after a QC pass and before completion: the portrait is with the
 * customer (approval) or on its way (print, shipping). A designer has nothing
 * to do here, but the card stays on their board in a quiet "With the customer"
 * state instead of disappearing until it completes.
 */
export const WITH_CUSTOMER_STATUSES = ["awaiting_approval", "approved", "printing", "shipped", "delivered"] as const;

/**
 * States an order can be SENT BACK to design from (a QC fail, a customer or
 * VA revision). A send-back asks for a new version, so a submission uploaded
 * before it no longer counts toward Submit for QC (enforced in
 * lib/orders/transitions.ts, mirrored in the card modal). Resuming from
 * on_hold is not a send-back.
 */
export const SENT_BACK_FROM = ["awaiting_qc", "awaiting_approval", "approved", "printing", "shipped", "delivered", "complete"] as const;

export function isWithCustomer(status: string): boolean {
  return (WITH_CUSTOMER_STATUSES as readonly string[]).includes(status);
}
