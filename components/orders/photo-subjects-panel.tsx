import { AlertTriangle, Camera } from "@/components/ui/icons";
import { sizedImageUrl } from "@/lib/images";
import {
  FACE_LABEL,
  holdingSubjects,
  joinNames,
  type PhotoSubject,
  type PhotoSubjects,
} from "@/lib/photos/subject-types";
import { cn } from "@/lib/utils";
import { PhotoSubjectFineForm } from "./photo-subject-fine-form";

/**
 * The pet slots (Yousif 2026-10-31, Delaney 4200623137 plan phase 1): every pet
 * or person bought, the photo a designer draws each face from, and who is still
 * waiting on a clear face photo. The agent's photo check fills it
 * (lib/photos/subjects.ts); staff can mark a held slot's photo fine. Presentation
 * only, so the order page, the board card and QC all use it.
 */
/** url null = a photo that could not be shown; it still counts for the numbering. */
type PanelPhoto = { id: string; url: string | null };

const WAITING_LINE: Record<"order" | "card" | "qc", string> = {
  order: "The designer cannot hand it in until one comes, or until someone marks the photo fine.",
  card: "We are getting one from the buyer and it shows here when it lands. It cannot go to QC before then.",
  qc: "Check that face against her photos before passing it, or mark the photo fine.",
};

export function PhotoSubjectsPanel({
  subjects: ps,
  photos,
  where,
  orderId,
  onMarked,
}: {
  subjects: PhotoSubjects | null | undefined;
  /** Her reference photos in upload order: "photo 2" is the second, as the check numbered them. */
  photos: PanelPhoto[];
  where: "order" | "card" | "qc";
  /** Set for staff only: shows "The photo is fine" on a held slot. */
  orderId?: string;
  /** After a slot is marked fine (the board card reloads its detail; pages refresh). */
  onMarked?: () => void;
}) {
  if (!ps || !Array.isArray(ps.subjects) || ps.subjects.length === 0) return null;
  const numberOf = new Map(photos.map((p, i) => [p.id, i + 1]));
  const photoOf = new Map(photos.map((p) => [p.id, p]));
  const waiting = holdingSubjects(ps);
  const seen = ps.photos ?? {};
  const unchecked = photos.filter((p) => !(p.id in seen)).length;
  const extra = Array.isArray(ps.extra) ? ps.extra.filter(Boolean) : [];

  return (
    <section aria-label="Who is in her photos" data-testid="photo-subjects" className="flex flex-col gap-2">
      <p className="text-xs font-semibold text-slate">Who is in her photos</p>
      {waiting.length > 0 && (
        <div role="status" className="flex items-start gap-2 rounded-input border border-amber bg-surface px-3 py-2 text-sm text-ink">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber" aria-hidden />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            <span className="font-semibold">No clear face photo of {joinNames(waiting.map((s) => s.name))} yet.</span>{" "}
            {WAITING_LINE[where]}
          </span>
        </div>
      )}
      {unchecked > 0 && (
        <p className="text-xs text-slate">
          {unchecked === 1 ? "A new photo came in and is being checked." : `${unchecked} new photos came in and are being checked.`}
        </p>
      )}
      <ul className="flex flex-col divide-y divide-line rounded-input border border-line bg-surface">
        {ps.subjects.map((s) => (
          <SubjectRow
            key={s.key}
            subject={s}
            best={s.bestAssetId ? (photoOf.get(s.bestAssetId) ?? null) : null}
            inPhotos={s.assetIds.map((id) => numberOf.get(id)).filter((n): n is number => typeof n === "number")}
            bestNumber={s.bestAssetId ? (numberOf.get(s.bestAssetId) ?? null) : null}
            orderId={orderId}
            onMarked={onMarked}
          />
        ))}
      </ul>
      {extra.length > 0 && (
        <p className="break-words text-xs text-slate [overflow-wrap:anywhere]">Also in her photos, not ordered: {extra.join("; ")}</p>
      )}
    </section>
  );
}

function SubjectRow({
  subject: s,
  best,
  inPhotos,
  bestNumber,
  orderId,
  onMarked,
}: {
  subject: PhotoSubject;
  best: PanelPhoto | null;
  inPhotos: number[];
  bestNumber: number | null;
  orderId?: string;
  onMarked?: () => void;
}) {
  const clear = s.face === "clear";
  const held = !clear && !s.cleared;
  const status = clear
    ? `${FACE_LABEL.clear}${bestNumber ? `: photo ${bestNumber}` : ""}`
    : s.cleared
      ? "Photo marked fine"
      : FACE_LABEL[s.face];
  const inLine = inPhotos.length ? `In photo${inPhotos.length > 1 ? "s" : ""} ${joinNames(inPhotos.map(String))}` : null;
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      {best?.url ? (
        <a href={best.url} target="_blank" rel="noopener noreferrer" aria-label={`Open the photo of ${s.name} full size`} className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sizedImageUrl(best.url, 96)} alt="" loading="lazy" decoding="async" className="size-12 rounded-input border border-line object-cover" />
        </a>
      ) : (
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-input border border-dashed border-line bg-canvas text-slate">
          <Camera size={16} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="break-words text-sm font-semibold text-ink [overflow-wrap:anywhere]">{s.name}</span>
          <span className={cn("text-xs font-medium", clear ? "text-sage" : held ? "text-amber" : "text-slate")}>{status}</span>
        </p>
        {s.description && <p className="break-words text-xs text-slate [overflow-wrap:anywhere]">{s.description}</p>}
        {!clear && s.note && <p className="break-words text-xs text-ink [overflow-wrap:anywhere]">{s.note}</p>}
        {!clear && inLine && <p className="text-xs text-slate">{inLine}</p>}
        {s.cleared && !clear && (
          <p className="break-words text-xs text-slate [overflow-wrap:anywhere]">
            {s.cleared.byName ?? "The team"}: {s.cleared.reason}
          </p>
        )}
        {held && orderId && <PhotoSubjectFineForm orderId={orderId} subjectKey={s.key} name={s.name} onMarked={onMarked} />}
      </div>
    </li>
  );
}
