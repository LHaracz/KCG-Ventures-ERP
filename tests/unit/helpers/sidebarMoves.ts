/**
 * The Marketing & Sales sidebar change, applied to an older recorded sidebar:
 * Sales Data, Sales Stats and Retail leave Fulfillment, and a new last
 * BotanIQals group "Marketing & Sales" holds Launch Pipeline, Prospecting,
 * Marketing Hub, Retail, Sales Data and Sales Stats (in that order).
 */
type Leaf = { href: string; label: string };
type Section = { title: string; items?: Leaf[]; categories?: Array<{ title: string; items: Leaf[] }> };

export const MARKETING_SALES_ITEMS: Leaf[] = [
  { href: "/growth/launches", label: "Launch Pipeline" },
  { href: "/growth/prospecting", label: "Prospecting" },
  { href: "/growth/marketing", label: "Marketing Hub" },
  { href: "/fulfillment/retail", label: "Retail" },
  { href: "/sales-data", label: "Sales Data" },
  { href: "/stats", label: "Sales Stats" },
];
const MOVED = new Set(["/sales-data", "/stats", "/fulfillment/retail"]);

export function withMarketingSales<T extends Section>(sections: readonly T[]): T[] {
  const out = JSON.parse(JSON.stringify(sections)) as T[];
  const botaniqals = out.find((s) => s.title === "BotanIQals");
  if (!botaniqals?.categories) return out;
  const f = botaniqals.categories.find((c) => c.title === "Fulfillment");
  if (f) f.items = f.items.filter((i) => !MOVED.has(i.href));
  botaniqals.categories.push({ title: "Marketing & Sales", items: MARKETING_SALES_ITEMS.map((i) => ({ ...i })) });
  return out;
}
