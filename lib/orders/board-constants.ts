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
