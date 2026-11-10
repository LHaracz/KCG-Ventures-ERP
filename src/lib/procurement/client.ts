"use client";

/**
 * Browser calls to /api/procurement. Writes always go through these server
 * routes (validated and access-checked there). Field errors from the server
 * are kept so forms can show them next to the right field.
 */
import { supabase } from "@/lib/supabaseClient";
import type { PoPrefillResult } from "./service";
import type { ProcurementData, Supplier, SupplierLink } from "./types";
import type { Errors, LinkValues, SupplierValues } from "./validation";

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
export const archiveSupplierApi = (id: string) => call<{ archivedLinks: number }>(`/api/procurement/suppliers/${encodeURIComponent(id)}/archive`, {});
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
