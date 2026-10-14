import type { QcAttachmentView } from "@/lib/qc/attachments";

/**
 * Pictures a reviewer attached to a failed QC, as tappable thumbnails that
 * open the full picture in a new tab (the link needs no login).
 */
export function QcPictures({ pictures, label = "Pictures from QC" }: { pictures: QcAttachmentView[]; label?: string }) {
  if (!pictures.length) return null;
  return (
    <div className="space-y-1" data-testid="qc-pictures">
      <p className="text-xs font-medium text-ink">{label}</p>
      <ul className="flex flex-wrap gap-2">
        {pictures.map((p, i) => (
          <li key={p.assetId}>
            <a
              href={p.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open QC picture ${i + 1} full size`}
              className="block size-20 overflow-hidden rounded-input border border-line bg-canvas sm:size-24"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={`QC picture ${i + 1}`} className="size-full object-cover" loading="lazy" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
