/**
 * Shared status-badge helper for the Fulfillments status pipeline (Part 2).
 * Deliberately solid-color + white text, per explicit request — a departure
 * from the light-bg/dark-text badge convention elsewhere (see
 * src/lib/feasibility.ts's feasibilityBadge for that convention), scoped to
 * this badge only.
 */

export const FULFILLMENT_STATUSES = [
  "preparing_shipment",
  "label_generated",
  "label_printed",
  "fulfilled",
] as const;

export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

const LABELS: Record<FulfillmentStatus, string> = {
  preparing_shipment: "Preparing Shipment",
  label_generated: "Label Generated",
  label_printed: "Label Printed",
  fulfilled: "Fulfilled",
};

const COLORS: Record<FulfillmentStatus, string> = {
  preparing_shipment: "bg-zinc-500 text-white",
  label_generated: "bg-amber-500 text-white",
  label_printed: "bg-blue-500 text-white",
  fulfilled: "bg-emerald-600 text-white",
};

export function fulfillmentStatusLabel(status: FulfillmentStatus | null | undefined): string {
  return LABELS[status ?? "preparing_shipment"];
}

export function fulfillmentStatusBadge(status: FulfillmentStatus | null | undefined): {
  label: string;
  className: string;
} {
  const s = status ?? "preparing_shipment";
  return {
    label: LABELS[s],
    className: `inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${COLORS[s]}`,
  };
}
