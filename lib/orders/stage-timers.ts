import type { OrderStatus } from "@/lib/orders/transitions";

export type StageTimerKey =
  | "awaiting_details"
  | "failed_qc"
  | "in_design"
  | "awaiting_photos"
  | "awaiting_qc"
  | "awaiting_customer"
  | "shipped_waiting_tracking"
  | "ready_to_ship"
  | "ready_to_assign";

export type StageTimer = {
  key: StageTimerKey | null;
  label: string;
  startedAt: string | null;
  deadlineAt: string | null;
  remainingMs: number | null;
  isOverdue: boolean;
  followUpDue: boolean;
  followUpLabel: string | null;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const DURATIONS: Record<StageTimerKey, number> = {
  awaiting_details: 12 * HOUR,
  failed_qc: 12 * HOUR,
  in_design: 48 * HOUR,
  awaiting_photos: 12 * HOUR,
  awaiting_qc: 6 * HOUR,
  awaiting_customer: 5 * DAY,
  shipped_waiting_tracking: 3 * DAY,
  ready_to_ship: 24 * HOUR,
  ready_to_assign: 12 * HOUR,
};

const LABELS: Record<StageTimerKey, string> = {
  awaiting_details: "Awaiting details",
  failed_qc: "Failed QC",
  in_design: "In design",
  awaiting_photos: "Needs photos",
  awaiting_qc: "Awaiting QC",
  awaiting_customer: "Awaiting customer",
  shipped_waiting_tracking: "Awaiting tracking",
  ready_to_ship: "Ready to ship",
  ready_to_assign: "Ready to assign",
};

export function stageTimer(input: {
  status: OrderStatus | string;
  derivedStatus: string;
  isPhysical: boolean;
  stageStartedAt: string | null;
  now?: Date;
}): StageTimer {
  const key = stageKey(input.status, input.derivedStatus);
  if (!key || !input.stageStartedAt) return emptyTimer(key);

  const started = new Date(input.stageStartedAt);
  if (Number.isNaN(started.getTime())) return emptyTimer(key);

  const now = input.now ?? new Date();
  const deadline = new Date(started.getTime() + DURATIONS[key]);
  const remainingMs = deadline.getTime() - now.getTime();
  const followUpDue =
    key === "awaiting_customer" &&
    input.isPhysical &&
    now.getTime() - started.getTime() >= 3 * DAY;

  return {
    key,
    label: LABELS[key],
    startedAt: started.toISOString(),
    deadlineAt: deadline.toISOString(),
    remainingMs,
    isOverdue: remainingMs < 0,
    followUpDue,
    followUpLabel: followUpDue ? "Follow up with customer" : null,
  };
}

export function formatStageRemaining(timer: StageTimer): string {
  if (timer.remainingMs == null) return "No stage clock";
  const abs = Math.abs(timer.remainingMs);
  const days = Math.floor(abs / DAY);
  const hours = Math.floor((abs % DAY) / HOUR);
  const minutes = Math.floor((abs % HOUR) / (60 * 1000));
  const parts =
    days > 0
      ? [`${days}d`, `${hours}h`]
      : hours > 0
        ? [`${hours}h`, `${minutes}m`]
        : [`${Math.max(1, minutes)}m`];
  const suffix = timer.isOverdue ? "overdue" : "left";
  return `${parts.join(" ")} ${suffix}`;
}

function stageKey(status: OrderStatus | string, derivedStatus: string): StageTimerKey | null {
  if (derivedStatus === "Failed QC") return "failed_qc";
  if (derivedStatus === "Ready to Ship") return "ready_to_ship";
  if (derivedStatus === "Shipped - Awaiting Tracking") return "shipped_waiting_tracking";
  if (status === "awaiting_details") return "awaiting_details";
  if (status === "awaiting_photos") return "awaiting_photos";
  if (status === "ready_to_assign") return "ready_to_assign";
  if (status === "in_design") return "in_design";
  if (status === "awaiting_qc") return "awaiting_qc";
  if (status === "awaiting_approval") return "awaiting_customer";
  return null;
}

function emptyTimer(key: StageTimerKey | null): StageTimer {
  return {
    key,
    label: key ? LABELS[key] : "No active timer",
    startedAt: null,
    deadlineAt: null,
    remainingMs: null,
    isOverdue: false,
    followUpDue: false,
    followUpLabel: null,
  };
}
