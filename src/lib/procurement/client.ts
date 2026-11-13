"use client";

/**
 * Browser calls to /api/procurement. Writes always go through these server
 * routes (validated and access-checked there). Field errors from the server
 * are kept so forms can show them next to the right field.
 */
import { supabase } from "@/lib/supabaseClient";
import type { PoPrefillResult } from "./service";
import type { EquipmentCategory, EquipmentItem, EquipmentLink, ProcurementData, Supplier, SupplierLink } from "./types";
import type { EquipmentLinkValues, EquipmentValues, Errors, LinkValues, SupplierValues } from "./validation";

export class ProcurementApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly fields: Errors | null) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${data.session?.access_token ?? ""}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; fields?: Errors | null };
  if (!res.ok) throw new ProcurementApiError(json.error || `Request failed (${res.status}).`, res.status, json.fields ?? null);
  return json as T;
}

export const fetchProcurement = () => call<ProcurementData>("/api/procurement");
export const createSupplierApi = (supplier: SupplierValues) => call<{ supplier: Supplier }>("/api/procurement/suppliers", { supplier });
export const updateSupplierApi = (id: string, supplier: SupplierValues) =>
  call<{ supplier: Supplier }>(`/api/procurement/suppliers/${encodeURIComponent(id)}`, { supplier });
export const archiveSupplierApi = (id: string) => call<{ archivedLinks: number; archivedEquipmentLinks: number }>(`/api/procurement/suppliers/${encodeURIComponent(id)}/archive`, {});
export const addLinkApi = (body: {
  raw_material_id: string;
  supplier_id?: string;
  new_supplier?: SupplierValues;
  link: LinkValues;
  make_preferred: boolean;
}) => call<{ link: SupplierLink }>("/api/procurement/links", body);
export const updateLinkApi = (id: string, body: { link: LinkValues; supplier?: SupplierValues; make_preferred: boolean }) =>
  call<{ link: SupplierLink }>(`/api/procurement/links/${encodeURIComponent(id)}`, body);
export const archiveLinkApi = (id: string) => call<{ link: SupplierLink }>(`/api/procurement/links/${encodeURIComponent(id)}/archive`, {});
export const makePreferredApi = (id: string) => call<{ link: SupplierLink }>(`/api/procurement/links/${encodeURIComponent(id)}/preferred`, {});
export const fetchPoPrefill = (supplierId: string, rawMaterialIds: string[]) =>
  call<PoPrefillResult>("/api/procurement/po-prefill", { supplier_id: supplierId, raw_material_ids: rawMaterialIds });
export const fetchEquipmentPoPrefill = (supplierId: string, equipmentId: string) =>
  call<PoPrefillResult>("/api/procurement/po-prefill", { supplier_id: supplierId, equipment_id: equipmentId });

// Equipment and categories
const enc = encodeURIComponent;
export const createCategoryApi = (name: string) => call<{ category: EquipmentCategory }>("/api/procurement/categories", { name });
export const renameCategoryApi = (id: string, name: string) => call<{ category: EquipmentCategory }>(`/api/procurement/categories/${enc(id)}`, { name });
export const archiveCategoryApi = (id: string) => call<{ category: EquipmentCategory }>(`/api/procurement/categories/${enc(id)}/archive`, {});
export const reorderCategoriesApi = (ids: string[]) => call<{ categories: EquipmentCategory[] }>("/api/procurement/categories/reorder", { ids });
export const createEquipmentApi = (equipment: EquipmentValues) => call<{ equipment: EquipmentItem }>("/api/procurement/equipment", { equipment });
export const updateEquipmentApi = (id: string, equipment: EquipmentValues) => call<{ equipment: EquipmentItem }>(`/api/procurement/equipment/${enc(id)}`, { equipment });
export const archiveEquipmentApi = (id: string) => call<{ archivedLinks: number }>(`/api/procurement/equipment/${enc(id)}/archive`, {});
export const restoreEquipmentApi = (id: string) => call<{ equipment: EquipmentItem }>(`/api/procurement/equipment/${enc(id)}/restore`, {});
export const addEquipmentLinkApi = (body: {
  equipment_id: string;
  supplier_id?: string;
  new_supplier?: SupplierValues;
  link: EquipmentLinkValues;
  make_preferred: boolean;
}) => call<{ link: EquipmentLink }>("/api/procurement/equipment-links", body);
export const updateEquipmentLinkApi = (id: string, body: { link: EquipmentLinkValues; supplier?: SupplierValues; make_preferred: boolean }) =>
  call<{ link: EquipmentLink }>(`/api/procurement/equipment-links/${enc(id)}`, body);
export const archiveEquipmentLinkApi = (id: string) => call<{ link: EquipmentLink }>(`/api/procurement/equipment-links/${enc(id)}/archive`, {});
export const makeEquipmentPreferredApi = (id: string) => call<{ link: EquipmentLink }>(`/api/procurement/equipment-links/${enc(id)}/preferred`, {});
