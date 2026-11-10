/**
 * Server-side Procurement data access. Called only from API routes that ran
 * guardApi() (feature inventory.purchase_orders) with the service-role
 * client. Every input is validated here; the database checks again.
 */
import { buildPoPrefill, buildSupplierInfo, type PoPrefill, type PrefillItem, type SupplierInfo } from "./poPrefill";
import { isUuid, validateLink, validateSupplier, type Errors, type LinkValues, type SupplierValues } from "./validation";
import {
  LINK_COLUMNS,
  MATERIAL_COLUMNS,
  SUPPLIER_COLUMNS,
  type ProcurementData,
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
  if (/rms_one_preferred_unique/.test(msg)) throw new ProcurementError("Another supplier was just made preferred. Refresh and try again.", 409);
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
  const [m, s, l] = await Promise.all([
    db.from("inventory_items").select(MATERIAL_COLUMNS).order("name", { ascending: true }),
    db.from("suppliers").select(SUPPLIER_COLUMNS).order("name", { ascending: true }),
    db.from("raw_material_suppliers").select(LINK_COLUMNS).is("archived_at", null),
  ]);
  if (m.error) fail(m.error, "Could not load raw materials.");
  if (s.error) fail(s.error, "Could not load suppliers.");
  if (l.error) fail(l.error, "Could not load supplier links.");
  return { materials: m.data ?? [], suppliers: s.data ?? [], links: l.data ?? [] };
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

export async function archiveSupplier(db: Db, id: unknown, actorName: string | null): Promise<{ archivedLinks: number }> {
  const s = await getActiveSupplier(db, id);
  const { data, error } = await db.rpc("archive_supplier", { p_supplier_id: s.id, p_actor_name: actorName });
  if (error) fail(error, "Could not archive the supplier.");
  return { archivedLinks: Number(data ?? 0) };
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

export type PoPrefillResult = { supplier_id: string; prefill: PoPrefill; supplierInfo: SupplierInfo };

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
    prefill: buildPoPrefill(supplier, items, { payment_terms: "" }),
    supplierInfo: buildSupplierInfo(supplier, items),
  };
}
