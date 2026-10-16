"use client";

import type { EyeData } from "@/lib/eye/data";

/** Placeholder shell: proves the route end to end. The visuals come in the next step. */
export function EyeClient({ initial }: { initial: EyeData }) {
  const t = initial.totals;
  const chips: [string, number][] = [
    ["Open", t.open],
    ["Delayed", t.delayed],
    ["Urgent", t.urgent],
    ["Waiting on buyer", t.waitingOnBuyer],
    ["Unhappy", t.unhappy],
    ["Printing", t.printing],
    ["Done today", t.completedToday],
  ];
  return (
    <div style={{ minHeight: "100vh", background: "#05070f", color: "#cfe3ff", padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ letterSpacing: "0.3em", fontSize: 20, fontWeight: 600 }}>THE ALL SEEING EYE</h1>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 24 }}>
        {chips.map(([label, n]) => (
          <span key={label} style={{ border: "1px solid #1d2b4a", borderRadius: 999, padding: "6px 14px", fontSize: 13 }}>
            {label} {n}
          </span>
        ))}
      </div>
      <ul style={{ marginTop: 24, listStyle: "none", padding: 0, fontSize: 14, lineHeight: 1.8 }}>
        {initial.businesses.map((b) => (
          <li key={b.id}>
            {b.name}: {b.openCount} open
          </li>
        ))}
      </ul>
    </div>
  );
}
