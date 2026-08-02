"use client";

import { useRouter } from "next/navigation";

import { Select } from "@/components/ui";

export function DesignerPicker({
  designers,
  current,
}: {
  designers: { id: string; name: string }[];
  current?: string;
}) {
  const router = useRouter();
  return (
    <div className="w-60">
      <Select
        label="View designer"
        value={current ?? ""}
        onChange={(e) => {
          if (e.target.value) router.push(`/board?designer=${e.target.value}`);
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
