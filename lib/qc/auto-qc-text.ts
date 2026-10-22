/**
 * Auto QC's wrong-file note as an owner reads it. The stored note names the portrait and the
 * finding's code, "Portrait 2 (other_order): This file shows Katie..."; the screen shows
 * "Portrait 2: This file shows Katie..." (2026-10-22). The stored text is left alone:
 * lib/qc/wrong-file.ts reads the portrait number from it.
 */
export function wrongFileNoteText(note: string): string {
  return note.replace(/\b(Portrait \d+) \([a-z_]+\):/g, "$1:");
}
