"use client";

import { useRouter } from "next/navigation";

import { Select } from "@/components/ui";

export function DesignerPicker({
  designers,
  current,
  onSelect,
}: {
  designers: { id: string; name: string }[];
  current?: string;
  /** Client-side switch (components/board/board-switcher.tsx); without it the picker navigates. */
  onSelect?: (id: string) => void;
}) {
  const router = useRouter();
  return (
    <div className="w-60">
      <Select
        label="View designer"
        value={current ?? ""}
        onChange={(e) => {
          if (!e.target.value) return;
          if (onSelect) onSelect(e.target.value);
          else router.push(`/board?designer=${e.target.value}`);
        }}
      >
        <option value="">Select a designer…</option>
        {designers.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
