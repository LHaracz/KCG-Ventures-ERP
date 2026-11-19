/**
 * Permanently deleting an equipment item (Admin only), and the suppliers
 * that were used only for it. The preview is read only (service role); the
 * delete runs delete_equipment_item() with the signed-in Admin's own token,
 * because the function checks is_admin() itself.
 */
import { isUuid } from "./validation";
import { ProcurementError, type Db } from "./service";

export type DeletePreviewSupplier = { id: string; name: string; willDelete: boolean; reason: string | null };
export type EquipmentDeletePreview = { equipment_id: string; equipment_name: string; listing_count: number; suppliers: DeletePreviewSupplier[] };
export type EquipmentDeleteResult = {
  equipment_name: string;
  deleted_suppliers: Array<{ id: string; name: string }>;
  kept_suppliers: Array<{ id: string; name: string; reason: string }>;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Also used for 2 ingredients and 1 other equipment item (Material A, Material B, Equipment B)". Names up to 3. */
export function keptReason(ingredientNames: readonly string[], equipmentNames: readonly string[]): string {
  const parts: string[] = [];
  if (ingredientNames.length) parts.push(plural(ingredientNames.length, "ingredient", "ingredients"));
  if (equipmentNames.length) parts.push(plural(equipmentNames.length, "other equipment item", "other equipment items"));
  const names = [...ingredientNames, ...equipmentNames];
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? `, and ${names.length - 3} more` : "");
  return `Also used for ${parts.join(" and ")} (${shown})`;
}

/** "Deleted Equipment A. Also deleted: Supplier A. Kept: Supplier B." */
export function deleteResultMessage(r: EquipmentDeleteResult): string {
  const list = (xs: Array<{ name: string }>) => (xs.length ? xs.map((x) => x.name).join(", ") : "none");
  return `Deleted ${r.equipment_name}. Also deleted: ${list(r.deleted_suppliers)}. Kept: ${list(r.kept_suppliers)}.`;
}

/** What a delete would do. Read only. */
export async function previewEquipmentDelete(db: Db, equipmentId: unknown): Promise<EquipmentDeletePreview> {
  if (!isUuid(equipmentId)) throw new ProcurementError("Equipment not found.", 404);
  const { data: item, error } = await db.from("equipment_items").select("id, name").eq("id", equipmentId).maybeSingle();
  if (error) throw new Error(`Could not load the equipment item. (${error.message})`);
  if (!item) throw new ProcurementError("Equipment not found.", 404);
  const { data: listings, error: lErr } = await db.from("equipment_suppliers").select("id, supplier_id").eq("equipment_id", equipmentId);
  if (lErr) throw new Error(`Could not load the supplier listings. (${lErr.message})`);
  const rows = (listings ?? []) as Array<{ id: string; supplier_id: string }>;
  const supplierIds = [...new Set(rows.map((l) => l.supplier_id))];
  if (supplierIds.length === 0) return { equipment_id: item.id, equipment_name: item.name, listing_count: 0, suppliers: [] };

  const [{ data: sups }, { data: rms }, { data: es }] = await Promise.all([
    db.from("suppliers").select("id, name").in("id", supplierIds),
    db.from("raw_material_suppliers").select("supplier_id, raw_material_id").in("supplier_id", supplierIds),
    db.from("equipment_suppliers").select("supplier_id, equipment_id").in("supplier_id", supplierIds).neq("equipment_id", equipmentId),
  ]);
  const rmIds = [...new Set(((rms ?? []) as Array<{ raw_material_id: string }>).map((r) => r.raw_material_id))];
  const eqIds = [...new Set(((es ?? []) as Array<{ equipment_id: string }>).map((r) => r.equipment_id))];
  const [{ data: mats }, { data: eqs }] = await Promise.all([
    rmIds.length ? db.from("inventory_items").select("id, name").in("id", rmIds) : Promise.resolve({ data: [] }),
    eqIds.length ? db.from("equipment_items").select("id, name").in("id", eqIds) : Promise.resolve({ data: [] }),
  ]);
  const matName = new Map(((mats ?? []) as Array<{ id: string; name: string | null }>).map((m) => [m.id, m.name ?? "Unnamed ingredient"]));
  const eqName = new Map(((eqs ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));

  const suppliers = ((sups ?? []) as Array<{ id: string; name: string }>)
    .map((s) => {
      const ingredients = [...new Set(((rms ?? []) as Array<{ supplier_id: string; raw_material_id: string }>).filter((r) => r.supplier_id === s.id).map((r) => matName.get(r.raw_material_id) ?? "Unnamed ingredient"))];
      const equipment = [...new Set(((es ?? []) as Array<{ supplier_id: string; equipment_id: string }>).filter((r) => r.supplier_id === s.id).map((r) => eqName.get(r.equipment_id) ?? "Unnamed equipment"))];
      const used = ingredients.length + equipment.length > 0;
      return { id: s.id, name: s.name, willDelete: !used, reason: used ? keptReason(ingredients, equipment) : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { equipment_id: item.id, equipment_name: item.name, listing_count: rows.length, suppliers };
}

/** Runs delete_equipment_item() with the Admin's own client (userDb). */
export async function deleteEquipment(userDb: Db, equipmentId: unknown, expectedSupplierIds: unknown, actorName: string | null): Promise<EquipmentDeleteResult> {
  if (!isUuid(equipmentId)) throw new ProcurementError("Equipment not found.", 404);
  const expected = Array.isArray(expectedSupplierIds) ? expectedSupplierIds.filter(isUuid) : [];
  const { data, error } = await userDb.rpc("delete_equipment_item", { p_equipment_id: equipmentId, p_expected_supplier_ids: expected, p_actor_name: actorName });
  if (error) {
    if (/Equipment not found/.test(error.message)) throw new ProcurementError("Equipment not found. It may already be deleted.", 404);
    if (/Only an Admin/.test(error.message)) throw new ProcurementError("Only an Admin can delete equipment.", 400);
    throw new Error(`Could not delete the equipment item. (${error.message})`);
  }
  return data as EquipmentDeleteResult;
}
