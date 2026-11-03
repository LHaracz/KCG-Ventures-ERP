/**
 * Server-side warehouse snapshot for the Pick List, Shipping Assignments and
 * the Fulfillments list's Box column: the cached orders (from the one shared
 * order loader) joined with staging boxes, open assignments, packaging rules,
 * presets and overrides, with each order's components resolved and its
 * effective package computed by the packaging engine.
 */
import type { FulfillmentListRow } from "@/lib/fulfillmentOrdersLoader";
import { buildComponentResolver, componentLines, resolveOrderComponents, type ResolvedComponent } from "@/lib/orderComponents";
import {
  effectivePackage,
  sizedPresets,
  suggestPackage,
  type EffectivePackage,
  type PackagingOverride,
  type PackagingPresetInput,
  type PackagingRuleInput,
} from "@/lib/packagingEngine";
import type { VariantMapRow } from "@/lib/salesAttribution";

type Db = { from(table: string): any };

export type PresetRow = {
  id: string;
  nickname: string;
  length_in: number;
  width_in: number;
  height_in: number;
  tare_weight_oz: number;
  max_points: number | string | null;
};

export type StagingBox = {
  id: string;
  boxNumber: number;
  label: string;
  archived: boolean;
  inUseByOrderId: string | null;
  inUseByOrderName: string | null;
};

export type WarehouseOrder = FulfillmentListRow & {
  components: ResolvedComponent[];
  componentLines: string[];
  unmappedLineItems: string[];
  boxId: string | null;
  boxLabel: string | null;
  pickedAt: string | null;
  packaging: EffectivePackage;
};

export type RecentPick = {
  orderId: string;
  orderName: string;
  boxLabel: string;
  assignedAt: string;
  open: boolean;
  status: string | null;
};

export type PackagingConfig = {
  presets: PresetRow[];
  presetInputs: PackagingPresetInput[];
  rules: PackagingRuleInput[];
  resolver: ReturnType<typeof buildComponentResolver>;
};

const must = <T,>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`Could not load ${what}: ${r.error.message}`);
  return r.data;
};

export async function loadPackagingConfig(db: Db): Promise<PackagingConfig> {
  const [presetsRes, rulesRes, mapRes, productsRes] = await Promise.all([
    db.from("package_presets").select("id, nickname, length_in, width_in, height_in, tare_weight_oz, max_points"),
    db.from("product_packaging_rules").select("product_id, points, min_package_id"),
    db.from("variant_component_map").select("lineitem_name, business, components"),
    db.from("products").select("id, name, is_microgreen"),
  ]);
  const presets = (must(presetsRes, "package presets") ?? []) as PresetRow[];
  const rules = ((must(rulesRes, "packaging rules") ?? []) as any[]).map((r) => ({
    productId: String(r.product_id),
    points: r.points ?? null,
    minPackageId: r.min_package_id ?? null,
  }));
  const variantMap = (must(mapRes, "variant mapping") ?? []) as VariantMapRow[];
  const products = (must(productsRes, "products") ?? []) as Array<{ id: string; name: string; is_microgreen: boolean }>;
  return {
    presets,
    presetInputs: presets.map((p) => ({ id: p.id, nickname: p.nickname, maxPoints: p.max_points })),
    rules,
    resolver: buildComponentResolver(variantMap, products),
  };
}

export function packagingForOrder(
  order: Pick<FulfillmentListRow, "lineItems">,
  config: PackagingConfig,
  override: PackagingOverride | null,
) {
  const resolved = resolveOrderComponents(order.lineItems, config.resolver);
  const suggestion = suggestPackage({
    components: resolved.components,
    unmappedLineItems: resolved.unmappedLineItems,
    rules: config.rules,
    presets: config.presetInputs,
  });
  return { resolved, packaging: effectivePackage(suggestion, override, config.presetInputs) };
}

export type WarehouseSnapshot = {
  orders: WarehouseOrder[];
  boxes: StagingBox[];
  presets: PresetRow[];
  /** Presets with max points, smallest first: one Shipping Assignments tab each. */
  tabs: Array<{ id: string; nickname: string; maxPoints: string }>;
  recentPicks: RecentPick[];
};

export async function loadWarehouseSnapshot(db: Db, orders: FulfillmentListRow[]): Promise<WarehouseSnapshot> {
  const [config, boxesRes, openRes, overridesRes, recentRes] = await Promise.all([
    loadPackagingConfig(db),
    db.from("staging_boxes").select("id, box_number, label, archived_at").order("box_number", { ascending: true }),
    db.from("staging_box_assignments").select("order_id, order_name, staging_box_id, assigned_at").is("released_at", null),
    db.from("order_packaging").select("order_id, override_target, override_preset_id, override_preset_name"),
    db
      .from("staging_box_assignments")
      .select("order_id, order_name, staging_box_id, assigned_at, released_at")
      .order("assigned_at", { ascending: false })
      .limit(20),
  ]);

  const boxRows = (must(boxesRes, "staging boxes") ?? []) as Array<{ id: string; box_number: number; label: string; archived_at: string | null }>;
  const open = (must(openRes, "staging assignments") ?? []) as Array<{ order_id: string; order_name: string | null; staging_box_id: string; assigned_at: string }>;
  const overrides = (must(overridesRes, "packaging overrides") ?? []) as Array<{
    order_id: string;
    override_target: "preset" | "needs_review";
    override_preset_id: string | null;
    override_preset_name: string | null;
  }>;
  const recent = (must(recentRes, "recent picks") ?? []) as Array<{
    order_id: string;
    order_name: string | null;
    staging_box_id: string;
    assigned_at: string;
    released_at: string | null;
  }>;

  const boxLabelById = new Map(boxRows.map((b) => [b.id, b.label]));
  const openByBox = new Map(open.map((a) => [a.staging_box_id, a]));
  const openByOrder = new Map(open.map((a) => [a.order_id, a]));
  const overrideByOrder = new Map(
    overrides.map((o) => [o.order_id, { target: o.override_target, presetId: o.override_preset_id, presetName: o.override_preset_name } as PackagingOverride]),
  );
  const statusByOrder = new Map(orders.map((o) => [o.orderId, o.status]));
  const nameByOrder = new Map(orders.map((o) => [o.orderId, o.name]));

  const warehouseOrders: WarehouseOrder[] = orders.map((o) => {
    const { resolved, packaging } = packagingForOrder(o, config, overrideByOrder.get(o.orderId) ?? null);
    const a = openByOrder.get(o.orderId);
    return {
      ...o,
      components: resolved.components,
      componentLines: componentLines(resolved.components),
      unmappedLineItems: resolved.unmappedLineItems,
      boxId: a?.staging_box_id ?? null,
      boxLabel: a ? boxLabelById.get(a.staging_box_id) ?? null : null,
      pickedAt: a ? toIso(a.assigned_at) : null,
      packaging,
    };
  });

  const boxes: StagingBox[] = boxRows.map((b) => {
    const a = openByBox.get(b.id);
    return {
      id: b.id,
      boxNumber: b.box_number,
      label: b.label,
      archived: !!b.archived_at,
      inUseByOrderId: a?.order_id ?? null,
      inUseByOrderName: a ? a.order_name ?? nameByOrder.get(a.order_id) ?? a.order_id : null,
    };
  });

  return {
    orders: warehouseOrders,
    boxes,
    presets: config.presets,
    tabs: sizedPresets(config.presetInputs).map((p) => ({ id: p.id, nickname: p.nickname, maxPoints: p.maxPoints.toString() })),
    recentPicks: recent.map((r) => ({
      orderId: r.order_id,
      orderName: r.order_name ?? nameByOrder.get(r.order_id) ?? r.order_id,
      boxLabel: boxLabelById.get(r.staging_box_id) ?? "",
      assignedAt: toIso(r.assigned_at),
      open: !r.released_at,
      status: statusByOrder.get(r.order_id) ?? null,
    })),
  };
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}
