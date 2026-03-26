export type BusinessType = "MiniLeaf" | "BotanIQals";

type MaybeCycleType = {
  business_type?: string | null;
  brand?: string | null;
};

export function normalizeBusinessType(
  input: MaybeCycleType,
  options?: { defaultType?: BusinessType | null },
): BusinessType | null {
  const bt = (input.business_type || "").trim().toLowerCase();
  const brand = (input.brand || "").trim().toLowerCase();

  if (bt === "minileaf" || brand === "minileaf") return "MiniLeaf";
  if (bt === "botaniqals" || brand === "botaniqals") return "BotanIQals";

  return options?.defaultType ?? null;
}
