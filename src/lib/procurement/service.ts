/**
 * Server-side Procurement data access. Called only from API routes that ran
 * guardApi() (feature inventory.purchase_orders) with the service-role
 * client. Every input is validated here; the database checks again.
 */
import {
  buildEquipmentPoPrefill,
  buildEquipmentSupplierInfo,
  buildPoPrefill,
  buildSupplierInfo,
  type PoPrefill,
  type PrefillItem,
  type SupplierInfo,
} from "./poPrefill";
import {
  isUuid,
  validateCategoryName,
  validateEquipment,
  validateEquipmentLink,
  validateLink,
  validateSupplier,
  type EquipmentLinkValues,
  type EquipmentValues,
  type Errors,
  type LinkValues,
  type SupplierValues,
} from "./validation";
import {
  CATEGORY_COLUMNS,
  EQUIPMENT_COLUMNS,
  EQUIPMENT_LINK_COLUMNS,
  LINK_COLUMNS,
  MATERIAL_COLUMNS,
  SUPPLIER_COLUMNS,
  type EquipmentCategory,
  type EquipmentItem,
  type EquipmentLink,
  type ProcurementData,
  type ProcurementTab,
  type RawMaterial,
  type Supplier,
  type SupplierLink,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = { from: (table: string) => any; rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> };

export class ProcurementError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
    public readonly fields?: Errors,
  ) {
    super(message);
  }
}

const MAX_PREFILL_IDS = 500;

function fail(error: { message: string } | null, fallback: string): never {
  const msg = error?.message ?? "";
  if (/suppliers_name_unique/.test(msg)) throw new ProcurementError("A supplier with this name already exists (it may be archived).", 409, { name: "A supplier with this name already exists." });
  if (/rms_active_pair_unique/.test(msg)) throw new ProcurementError("This supplier is already listed for this ingredient.", 409);
  if (/rms_one_preferred_unique|es_one_preferred_unique/.test(msg)) throw new ProcurementError("Another supplier was just made preferred. Refresh and try again.", 409);
  if (/es_active_pair_unique/.test(msg)) throw new ProcurementError("This supplier is already listed for this equipment item.", 409);
  if (/equipment_items_name_unique/.test(msg)) throw new ProcurementError("An equipment item with this name already exists.", 409, { name: "An equipment item with this name already exists." });
  if (/equipment_categories_name_unique/.test(msg)) throw new ProcurementError("A category with this name already exists.", 409, { category: "A category with this name already exists." });
  if (/use(s)? this category/.test(msg)) throw new ProcurementError(msg.replace(/^.*?(\d+ items? uses? this category)/, "$1"), 409);
  if (/category is archived/.test(msg)) throw new ProcurementError("That category is archived. Choose an active category.", 400, { category_id: "Choose an active category." });
  if (/check constraint/.test(msg)) throw new ProcurementError("Some details are not valid. Check the highlighted fields.", 400);
  throw new Error(msg ? `${fallback} (${msg})` : fallback);
}

function supplierOrThrow(input: unknown): SupplierValues {
  const r = validateSupplier(input);
  if (!r.ok) throw new ProcurementError("Some supplier details are not valid.", 400, r.errors);
  return r.value;
}
function linkOrThrow(input: unknown): LinkValues {
  const r = validateLink(input);
  if (!r.ok) throw new ProcurementError("Some ingredient details are not valid.", 400, r.errors);
  return r.value;
}
function idOrThrow(id: unknown, what: string): string {
  if (!isUuid(id)) throw new ProcurementError(`Unknown ${what}.`, 404);
  return id;
}

export async function loadProcurementData(db: Db): Promise<ProcurementData> {
  const [m, s, l, c, e, el] = await Promise.all([
    db.from("inventory_items").select(MATERIAL_COLUMNS).order("name", { ascending: true }),
    db.from("suppliers").select(SUPPLIER_COLUMNS).order("name", { ascending: true }),
    db.from("raw_material_suppliers").select(LINK_COLUMNS).is("archived_at", null),
    db.from("equipment_categories").select(CATEGORY_COLUMNS).order("sort_order", { ascending: true }),
    db.from("equipment_items").select(EQUIPMENT_COLUMNS).order("name", { ascending: true }),
    db.from("equipment_suppliers").select(EQUIPMENT_LINK_COLUMNS).is("archived_at", null),
  ]);
  if (m.error) fail(m.error, "Could not load raw materials.");
  if (s.error) fail(s.error, "Could not load suppliers.");
  if (l.error) fail(l.error, "Could not load supplier links.");
  if (c.error) fail(c.error, "Could not load equipment categories.");
  if (e.error) fail(e.error, "Could not load equipment.");
  if (el.error) fail(el.error, "Could not load equipment supplier listings.");
  return {
    materials: m.data ?? [],
    suppliers: s.data ?? [],
    links: l.data ?? [],
    categories: c.data ?? [],
    equipment: e.data ?? [],
    equipmentLinks: el.data ?? [],
  };
}

async function getSupplier(db: Db, id: string): Promise<Supplier | null> {
  const { data, error } = await db.from("suppliers").select(SUPPLIER_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail(error, "Could not load the supplier.");
  return data ?? null;
}
async function getActiveSupplier(db: Db, id: unknown): Promise<Supplier> {
  const sid = idOrThrow(id, "supplier");
  const s = await getSupplier(db, sid);
  if (!s) throw new ProcurementError("Unknown supplier.", 404);
  if (s.archived_at) throw new ProcurementError("This supplier is archived.", 400);
  return s;
}
async function getMaterial(db: Db, id: unknown): Promise<RawMaterial> {
  const mid = idOrThrow(id, "raw material");
  const { data, error } = await db.from("inventory_items").select(MATERIAL_COLUMNS).eq("id", mid).maybeSingle();
  if (error) fail(error, "Could not load the raw material.");
  if (!data) throw new ProcurementError("Unknown raw material.", 404);
  return data;
}
async function getActiveLink(db: Db, id: unknown): Promise<SupplierLink> {
  const lid = idOrThrow(id, "supplier link");
  const { data, error } = await db.from("raw_material_suppliers").select(LINK_COLUMNS).eq("id", lid).maybeSingle();
  if (error) fail(error, "Could not load the supplier link.");
  if (!data) throw new ProcurementError("Unknown supplier link.", 404);
  if (data.archived_at) throw new ProcurementError("This supplier link was removed.", 400);
  return data;
}

export async function createSupplier(db: Db, input: unknown, actorName: string | null): Promise<Supplier> {
  const v = supplierOrThrow(input);
  const { data, error } = await db.from("suppliers").insert({ ...v, updated_by_name: actorName }).select(SUPPLIER_COLUMNS).single();
  if (error) fail(error, "Could not save the supplier.");
  return data;
}

export async function updateSupplier(db: Db, id: unknown, input: unknown, actorName: string | null): Promise<Supplier> {
  const current = await getActiveSupplier(db, id);
  const v = supplierOrThrow(input);
  const { data, error } = await db
    .from("suppliers")
    .update({ ...v, updated_by_name: actorName })
    .eq("id", current.id)
    .select(SUPPLIER_COLUMNS)
    .single();
  if (error) fail(error, "Could not save the supplier.");
  return data;
}

/** Archives a supplier with its raw material AND equipment listings. Nothing is deleted. */
export async function archiveSupplier(
  db: Db,
  id: unknown,
  actorName: string | null,
): Promise<{ archivedLinks: number; archivedEquipmentLinks: number }> {
  const s = await getActiveSupplier(db, id);
  const { data, error } = await db.rpc("archive_supplier_listings", { p_supplier_id: s.id, p_actor_name: actorName });
  if (error) fail(error, "Could not archive the supplier.");
  const r = (typeof data === "string" ? JSON.parse(data) : data ?? {}) as { raw_material_listings?: number; equipment_listings?: number };
  return { archivedLinks: Number(r.raw_material_listings ?? 0), archivedEquipmentLinks: Number(r.equipment_listings ?? 0) };
}

/**
 * Adds a supplier to a raw material: an existing supplier (supplier_id) or a
 * new one (new_supplier). The first active supplier becomes preferred
 * automatically (database trigger); make_preferred moves the star.
 */
export async function addLink(
  db: Db,
  body: { raw_material_id?: unknown; supplier_id?: unknown; new_supplier?: unknown; link?: unknown; make_preferred?: unknown },
  actorName: string | null,
): Promise<SupplierLink> {
  const material = await getMaterial(db, body.raw_material_id);
  const link = linkOrThrow(body.link);
  let supplierId: string;
  if (body.new_supplier !== undefined && body.new_supplier !== null) {
    const values = supplierOrThrow(body.new_supplier);
    supplierId = (await createSupplier(db, values, actorName)).id;
  } else {
    supplierId = (await getActiveSupplier(db, body.supplier_id)).id;
  }
  const { data, error } = await db
    .from("raw_material_suppliers")
    .insert({ raw_material_id: material.id, supplier_id: supplierId, ...link })
    .select(LINK_COLUMNS)
    .single();
  if (error) fail(error, "Could not add the supplier.");
  if (body.make_preferred === true && !data.is_preferred) return makePreferred(db, data.id);
  return data;
}

/** Updates a link's ingredient-level details, and (when sent) its supplier's shared details. */
export async function updateLink(
  db: Db,
  linkId: unknown,
  body: { link?: unknown; supplier?: unknown; make_preferred?: unknown },
  actorName: string | null,
): Promise<SupplierLink> {
  const current = await getActiveLink(db, linkId);
  const link = linkOrThrow(body.link);
  const supplierValues = body.supplier !== undefined && body.supplier !== null ? supplierOrThrow(body.supplier) : null;
  if (supplierValues) await updateSupplier(db, current.supplier_id, supplierValues, actorName);
  const { data, error } = await db.from("raw_material_suppliers").update(link).eq("id", current.id).select(LINK_COLUMNS).single();
  if (error) fail(error, "Could not save the supplier link.");
  if (body.make_preferred === true && !data.is_preferred) return makePreferred(db, data.id);
  return data;
}

export async function archiveLink(db: Db, linkId: unknown): Promise<SupplierLink> {
  const current = await getActiveLink(db, linkId);
  const { data, error } = await db
    .from("raw_material_suppliers")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", current.id)
    .select(LINK_COLUMNS)
    .single();
  if (error) fail(error, "Could not remove the supplier.");
  return data;
}

export async function makePreferred(db: Db, linkId: unknown): Promise<SupplierLink> {
  const current = await getActiveLink(db, linkId);
  const { error } = await db.rpc("set_preferred_supplier", { p_raw_material_id: current.raw_material_id, p_link_id: current.id });
  if (error) fail(error, "Could not change the preferred supplier.");
  return { ...current, is_preferred: true };
}

export type PoPrefillResult = {
  supplier_id: string;
  /** Which Procurement tab "Back to Procurement" returns to. */
  tab: ProcurementTab;
  prefill: PoPrefill;
  supplierInfo: SupplierInfo;
};

/**
 * Loads the supplier and raw materials by id and builds the PO prefill.
 * Rejects unknown or archived suppliers, unknown raw materials, and raw
 * materials this supplier is not (actively) listed for.
 */
export async function loadPoPrefill(db: Db, supplierId: unknown, materialIds: unknown): Promise<PoPrefillResult> {
  const supplier = await getActiveSupplier(db, supplierId);
  if (materialIds !== undefined && !Array.isArray(materialIds)) throw new ProcurementError("Unknown raw material.", 404);
  const ids = [...new Set((materialIds ?? []) as unknown[])];
  if (ids.length > MAX_PREFILL_IDS) throw new ProcurementError(`At most ${MAX_PREFILL_IDS} ingredients can be sent at once.`, 400);
  for (const id of ids) idOrThrow(id, "raw material");

  let items: PrefillItem[] = [];
  if (ids.length > 0) {
    const [m, l] = await Promise.all([
      db.from("inventory_items").select(MATERIAL_COLUMNS).in("id", ids),
      db.from("raw_material_suppliers").select(LINK_COLUMNS).eq("supplier_id", supplier.id).is("archived_at", null),
    ]);
    if (m.error) fail(m.error, "Could not load raw materials.");
    if (l.error) fail(l.error, "Could not load supplier links.");
    const materials = new Map<string, RawMaterial>((m.data ?? []).map((r: RawMaterial) => [r.id, r]));
    const links = new Map<string, SupplierLink>((l.data ?? []).map((r: SupplierLink) => [r.raw_material_id, r]));
    items = (ids as string[]).map((id) => {
      const material = materials.get(id);
      if (!material) throw new ProcurementError("Unknown raw material.", 404);
      const link = links.get(id);
      if (!link) throw new ProcurementError(`${supplier.name} is not listed as a supplier for ${material.name}.`, 400);
      return { material, link };
    });
  }
  return {
    supplier_id: supplier.id,
    tab: "raw",
    prefill: buildPoPrefill(supplier, items, { payment_terms: "" }),
    supplierInfo: buildSupplierInfo(supplier, items),
  };
}

// --- Equipment categories -------------------------------------------------------------
function categoryNameOrThrow(input: unknown): string {
  const r = validateCategoryName(input);
  if (!r.ok) throw new ProcurementError(r.error, 400, { category: r.error });
  return r.value;
}
async function getActiveCategory(db: Db, id: unknown): Promise<EquipmentCategory> {
  const cid = idOrThrow(id, "category");
  const { data, error } = await db.from("equipment_categories").select(CATEGORY_COLUMNS).eq("id", cid).maybeSingle();
  if (error) fail(error, "Could not load the category.");
  if (!data) throw new ProcurementError("Unknown category.", 404);
  if (data.archived_at) throw new ProcurementError("That category is archived. Choose an active category.", 400, { category_id: "Choose an active category." });
  return data;
}
async function activeCategories(db: Db): Promise<EquipmentCategory[]> {
  const { data, error } = await db.from("equipment_categories").select(CATEGORY_COLUMNS).is("archived_at", null).order("sort_order", { ascending: true });
  if (error) fail(error, "Could not load equipment categories.");
  return data ?? [];
}

export async function createCategory(db: Db, name: unknown): Promise<EquipmentCategory> {
  const v = categoryNameOrThrow(name);
  const next = (await activeCategories(db)).reduce((m, c) => Math.max(m, c.sort_order), 0) + 1;
  const { data, error } = await db.from("equipment_categories").insert({ name: v, sort_order: next }).select(CATEGORY_COLUMNS).single();
  if (error) fail(error, "Could not add the category.");
  return data;
}

export async function renameCategory(db: Db, id: unknown, name: unknown): Promise<EquipmentCategory> {
  const c = await getActiveCategory(db, id);
  const v = categoryNameOrThrow(name);
  const { data, error } = await db.from("equipment_categories").update({ name: v }).eq("id", c.id).select(CATEGORY_COLUMNS).single();
  if (error) fail(error, "Could not rename the category.");
  return data;
}

/** Blocked by the database while any active equipment item uses the category. */
export async function archiveCategory(db: Db, id: unknown): Promise<EquipmentCategory> {
  const c = await getActiveCategory(db, id);
  const { data, error } = await db
    .from("equipment_categories")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", c.id)
    .select(CATEGORY_COLUMNS)
    .single();
  if (error) fail(error, "Could not archive the category.");
  return data;
}

/** Sets the order of the active categories. ids must be exactly the active categories. */
export async function reorderCategories(db: Db, ids: unknown): Promise<EquipmentCategory[]> {
  const active = await activeCategories(db);
  if (!Array.isArray(ids) || ids.length !== active.length || new Set(ids).size !== ids.length || !ids.every((id) => active.some((c) => c.id === id))) {
    throw new ProcurementError("The category list changed. Refresh and try again.", 409);
  }
  for (let i = 0; i < ids.length; i++) {
    const { error } = await db.from("equipment_categories").update({ sort_order: i + 1 }).eq("id", ids[i] as string);
    if (error) fail(error, "Could not reorder the categories.");
  }
  return activeCategories(db);
}

// --- Equipment items --------------------------------------------------------------------
function equipmentOrThrow(input: unknown): EquipmentValues {
  const r = validateEquipment(input);
  if (!r.ok) throw new ProcurementError("Some equipment details are not valid.", 400, r.errors);
  return r.value;
}
async function getEquipment(db: Db, id: unknown): Promise<EquipmentItem> {
  const eid = idOrThrow(id, "equipment item");
  const { data, error } = await db.from("equipment_items").select(EQUIPMENT_COLUMNS).eq("id", eid).maybeSingle();
  if (error) fail(error, "Could not load the equipment item.");
  if (!data) throw new ProcurementError("Unknown equipment item.", 404);
  return data;
}
async function getActiveEquipment(db: Db, id: unknown): Promise<EquipmentItem> {
  const e = await getEquipment(db, id);
  if (e.archived_at) throw new ProcurementError("This equipment item is archived.", 400);
  return e;
}

export async function createEquipment(db: Db, input: unknown, actorName: string | null): Promise<EquipmentItem> {
  const v = equipmentOrThrow(input);
  await getActiveCategory(db, v.category_id);
  const { data, error } = await db.from("equipment_items").insert({ ...v, updated_by_name: actorName }).select(EQUIPMENT_COLUMNS).single();
  if (error) fail(error, "Could not add the equipment item.");
  return data;
}

export async function updateEquipment(db: Db, id: unknown, input: unknown, actorName: string | null): Promise<EquipmentItem> {
  const current = await getActiveEquipment(db, id);
  const v = equipmentOrThrow(input);
  await getActiveCategory(db, v.category_id);
  const { data, error } = await db.from("equipment_items").update({ ...v, updated_by_name: actorName }).eq("id", current.id).select(EQUIPMENT_COLUMNS).single();
  if (error) fail(error, "Could not save the equipment item.");
  return data;
}

/** Archives the item and its supplier listings. */
export async function archiveEquipment(db: Db, id: unknown, actorName: string | null): Promise<{ archivedLinks: number }> {
  const e = await getActiveEquipment(db, id);
  const { data, error } = await db.rpc("archive_equipment_item", { p_equipment_id: e.id, p_actor_name: actorName });
  if (error) fail(error, "Could not archive the equipment item.");
  return { archivedLinks: Number(data ?? 0) };
}

/** Brings an archived item back (its old listings stay archived; add suppliers again). */
export async function restoreEquipment(db: Db, id: unknown, actorName: string | null): Promise<EquipmentItem> {
  const e = await getEquipment(db, id);
  if (!e.archived_at) throw new ProcurementError("This equipment item is not archived.", 400);
  await getActiveCategory(db, e.category_id).catch(() => {
    throw new ProcurementError("Its category is archived. Restore needs an active category: add or pick one, then try again.", 400);
  });
  const { data, error } = await db.from("equipment_items").update({ archived_at: null, updated_by_name: actorName }).eq("id", e.id).select(EQUIPMENT_COLUMNS).single();
  if (error) fail(error, "Could not restore the equipment item.");
  return data;
}

// --- Equipment supplier listings -------------------------------------------------------
function equipmentLinkOrThrow(input: unknown): EquipmentLinkValues {
  const r = validateEquipmentLink(input);
  if (!r.ok) throw new ProcurementError("Some listing details are not valid.", 400, r.errors);
  return r.value;
}
async function getActiveEquipmentLink(db: Db, id: unknown): Promise<EquipmentLink> {
  const lid = idOrThrow(id, "supplier listing");
  const { data, error } = await db.from("equipment_suppliers").select(EQUIPMENT_LINK_COLUMNS).eq("id", lid).maybeSingle();
  if (error) fail(error, "Could not load the supplier listing.");
  if (!data) throw new ProcurementError("Unknown supplier listing.", 404);
  if (data.archived_at) throw new ProcurementError("This supplier listing was removed.", 400);
  return data;
}

/** Adds a supplier (existing, from either tab, or new) to an equipment item. */
export async function addEquipmentLink(
  db: Db,
  body: { equipment_id?: unknown; supplier_id?: unknown; new_supplier?: unknown; link?: unknown; make_preferred?: unknown },
  actorName: string | null,
): Promise<EquipmentLink> {
  const item = await getActiveEquipment(db, body.equipment_id);
  const link = equipmentLinkOrThrow(body.link);
  let supplierId: string;
  if (body.new_supplier !== undefined && body.new_supplier !== null) {
    supplierId = (await createSupplier(db, supplierOrThrow(body.new_supplier), actorName)).id;
  } else {
    supplierId = (await getActiveSupplier(db, body.supplier_id)).id;
  }
  const { data: dup, error: dupError } = await db
    .from("equipment_suppliers")
    .select("id")
    .eq("equipment_id", item.id)
    .eq("supplier_id", supplierId)
    .is("archived_at", null)
    .maybeSingle();
  if (dupError) fail(dupError, "Could not check the supplier listings.");
  if (dup) throw new ProcurementError("This supplier is already listed for this equipment item.", 409, { supplier_id: "Already listed for this item." });
  const { data, error } = await db
    .from("equipment_suppliers")
    .insert({ equipment_id: item.id, supplier_id: supplierId, ...link })
    .select(EQUIPMENT_LINK_COLUMNS)
    .single();
  if (error) fail(error, "Could not add the supplier.");
  if (body.make_preferred === true && !data.is_preferred) return makeEquipmentPreferred(db, data.id);
  return data;
}

export async function updateEquipmentLink(
  db: Db,
  linkId: unknown,
  body: { link?: unknown; supplier?: unknown; make_preferred?: unknown },
  actorName: string | null,
): Promise<EquipmentLink> {
  const current = await getActiveEquipmentLink(db, linkId);
  const link = equipmentLinkOrThrow(body.link);
  const supplierValues = body.supplier !== undefined && body.supplier !== null ? supplierOrThrow(body.supplier) : null;
  if (supplierValues) await updateSupplier(db, current.supplier_id, supplierValues, actorName);
  const { data, error } = await db.from("equipment_suppliers").update(link).eq("id", current.id).select(EQUIPMENT_LINK_COLUMNS).single();
  if (error) fail(error, "Could not save the supplier listing.");
  if (body.make_preferred === true && !data.is_preferred) return makeEquipmentPreferred(db, data.id);
  return data;
}

export async function archiveEquipmentLink(db: Db, linkId: unknown): Promise<EquipmentLink> {
  const current = await getActiveEquipmentLink(db, linkId);
  const { data, error } = await db
    .from("equipment_suppliers")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", current.id)
    .select(EQUIPMENT_LINK_COLUMNS)
    .single();
  if (error) fail(error, "Could not remove the supplier.");
  return data;
}

export async function makeEquipmentPreferred(db: Db, linkId: unknown): Promise<EquipmentLink> {
  const current = await getActiveEquipmentLink(db, linkId);
  const { error } = await db.rpc("set_preferred_equipment_supplier", { p_equipment_id: current.equipment_id, p_link_id: current.id });
  if (error) fail(error, "Could not change the preferred supplier.");
  return { ...current, is_preferred: true };
}

/**
 * Prefill for a PO for one equipment item from one supplier. Rejects
 * unknown or archived suppliers and items, and a supplier that is not
 * actively listed for the item.
 */
export async function loadEquipmentPoPrefill(db: Db, supplierId: unknown, equipmentId: unknown): Promise<PoPrefillResult> {
  const supplier = await getActiveSupplier(db, supplierId);
  const item = await getActiveEquipment(db, equipmentId);
  const { data: link, error } = await db
    .from("equipment_suppliers")
    .select(EQUIPMENT_LINK_COLUMNS)
    .eq("equipment_id", item.id)
    .eq("supplier_id", supplier.id)
    .is("archived_at", null)
    .maybeSingle();
  if (error) fail(error, "Could not load the supplier listing.");
  if (!link) throw new ProcurementError(`${supplier.name} is not listed as a supplier for ${item.name}.`, 400);
  return {
    supplier_id: supplier.id,
    tab: "equipment",
    prefill: buildEquipmentPoPrefill(supplier, item, link, { payment_terms: "" }),
    supplierInfo: buildEquipmentSupplierInfo(supplier, item, link),
  };
}
