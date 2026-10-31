// Every pet has its photo before anyone draws (Yousif 2026-10-31, Delaney
// 4200623137 plan phase 1): each pet or person bought gets its own named slot
// on the card, filled from her photos and labelled by who is in them. The
// agent's photo check writes it (POST /api/agent-photos/subjects); the card,
// the order page, QC and the hand-in gate read it.
//
// Plain data and pure helpers, no imports: lib/db/schema.ts and client
// components both use it.

/** How well her photos show this one's face: "clear" = a designer can draw it from them. */
export type SubjectFace = "clear" | "unclear" | "none";

/** A staff member's "the photo is fine" on a slot the check held. */
export type SubjectClear = { by: string; byName: string | null; at: string; reason: string };

export type PhotoSubject = {
  /** Stable within the order: "rambo", "pet-2". */
  key: string;
  /** Her name for it when she gave one ("Rambo"), else how she would say it ("your black cat"). */
  name: string;
  kind: "pet" | "person" | "other";
  /** What it looks like, for telling the photos apart ("brown and white beagle"). */
  description: string | null;
  face: SubjectFace;
  /** The photo a designer should draw the face from. */
  bestAssetId: string | null;
  /** Every reference photo it is in. */
  assetIds: string[];
  /** Why the face is not clear ("only the back of his head"). */
  note: string | null;
  cleared?: SubjectClear | null;
};

export type PhotoSubjects = {
  checkedAt: string;
  /** Which reference photos the check saw (lib/photos/subjects.ts photoSigOf); a different set = a new check is due. */
  photoSig: string;
  model: string | null;
  subjects: PhotoSubject[];
  /** Reference asset id -> the subject keys in that photo ([] = none of them). */
  photos: Record<string, string[]>;
  /** People or pets in her photos that were not bought ("a second dog in photo 3"). */
  extra: string[];
};

/** The slots still holding the order: no clear face photo and no staff clear. */
export function holdingSubjects(ps: PhotoSubjects | null | undefined): PhotoSubject[] {
  if (!ps || !Array.isArray(ps.subjects)) return [];
  return ps.subjects.filter((s) => s.face !== "clear" && !s.cleared);
}

/** "Rambo", "Jax and Rambo", "Jax, Rambo and Bella". */
export function joinNames(names: string[]): string {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

export const FACE_LABEL: Record<SubjectFace, string> = {
  clear: "Clear face photo",
  unclear: "Face not clear",
  none: "No photo of them",
};

/**
 * How the buyer would say it in an email to her. The photo check names the
 * buyer herself "the customer" and someone it knows only by who they are to
 * her "her fiancé" (2026-10-31); in her email those are "you" and "your
 * fiancé". A pet with no name, "the black lab", becomes "your black lab". An
 * aside in brackets ("Rambo (the beagle)") is the team's, never hers.
 */
export function buyerName(s: Pick<PhotoSubject, "name" | "kind">): string {
  const name = s.name.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim() || s.name.trim();
  if (/^(the (customer|buyer)|she|her|herself)$/i.test(name)) return "you";
  const hers = /^(her|the (customer|buyer)['’]s)\s+/i;
  if (hers.test(name)) return name.replace(hers, "your ");
  return s.kind === "person" ? name : name.replace(/^the\s+/i, "your ");
}

const possessive = (name: string) => (name === "you" ? "your" : /s$/i.test(name) ? `${name}'` : `${name}'s`);

/**
 * The words of the one "clear face photo" ask (template photo_subject_ask):
 * everyone the portrait is of, and whose face is missing.
 *   subject_names          "Jax and Rambo"
 *   subject_missing_faces  "a clear photo of Rambo's face" / "clear photos of Jax's and Rambo's faces"
 *   subject_add_line       "If you have one, you can add it here:" / "If you have them, ..."
 */
export function subjectAskVars(
  all: Pick<PhotoSubject, "name" | "kind">[],
  missing: Pick<PhotoSubject, "name" | "kind">[],
): { subject_names: string; subject_missing_faces: string; subject_add_line: string } {
  const names = all.map(buyerName);
  const gone = missing.map(buyerName);
  const faces = missing.every((s) => s.kind !== "other");
  let missingFaces: string;
  if (gone.length === 1) missingFaces = faces ? `a clear photo of ${possessive(gone[0])} face` : `a clear photo of ${gone[0]}`;
  else missingFaces = faces ? `clear photos of ${joinNames(gone.map(possessive))} faces` : `clear photos of ${joinNames(gone)}`;
  return {
    subject_names: joinNames(names.length ? names : gone),
    subject_missing_faces: missingFaces,
    subject_add_line: gone.length === 1 ? "If you have one, you can add it here:" : "If you have them, you can add them here:",
  };
}
