/**
 * Shared types + fetch helpers for Purchase Orders (Phase 2: the PO data
 * model itself, on top of Phase 1's company_profiles/po_prefix work in
 * companyProfiles.ts).
 *
 * Reads, soft-delete/restore are plain `supabase.from(...)` calls (RLS
 * already permits any authenticated user, same as companyProfiles.ts) —
 * mirrors employees.ts's "thin query helper" shape. Create and edit are
 * NOT done this way: they go through /api/purchase-orders, which calls the
 * create_purchase_order / update_purchase_order Postgres functions (see
 * purchase_orders_documents.sql) via the service-role client, exactly like
 * the Receiving Log's submit route — those functions are the only place
 * line totals, subtotal, tax, and total are computed, and the client's own
 * numbers are never trusted for the actual save.
 */

export type ShipTo = {
  same_as_bill_to: boolean;
  name: string;
  contact_name: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  delivery_instructions: string;
};

export const EMPTY_SHIP_TO: ShipTo = {
  same_as_bill_to: true,
  name: "",
  contact_name: "",
  phone: "",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  zip: "",
  country: "",
  delivery_instructions: "",
};

export type CompanySnapshot = {
  display_name: string;
  legal_name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logo_path: string | null;
  accent_color: string;
  footer_note: string | null;
};

export type PoLine = {
  id: string;
  po_id: string;
  line_number: number;
  item_number: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
};

export type PurchaseOrder = {
  id: string;
  po_number: string;
  prefix: string;
  year: number;
  sequence: number;

  company_profile_id: string;
  company_snapshot: CompanySnapshot;

  order_date: string;
  needed_by_date: string;

  vendor_name: string;
  vendor_contact_name: string | null;
  vendor_email: string | null;
  vendor_phone: string | null;
  vendor_account_number: string | null;
  vendor_address_line1: string;
  vendor_address_line2: string | null;
  vendor_city: string;
  vendor_state: string;
  vendor_zip: string;
  vendor_country: string;

  ship_to: ShipTo;

  payment_terms: string;
  shipping_method: string;
  freight_terms: string;
  reference_number: string | null;

  prepared_by_name: string;
  authorized_by_name: string;
  authorized_by_title: string;
  buyer_phone: string;
  buyer_email: string;

  shipping_cost: number;
  tax_exempt: boolean;
  tax_rate_percent: number;
  subtotal: number;
  tax_amount: number;
  total: number;

  special_instructions: string | null;
  terms_text: string;
  notes_to_vendor: string | null;
  internal_notes: string | null;

  deleted_at: string | null;
  last_downloaded_at: string | null;
  created_at: string;
  updated_at: string;
  created_by_account: string | null;
};

export type PurchaseOrderWithLines = PurchaseOrder & { po_lines: PoLine[] };

export const PO_COLUMNS =
  "id, po_number, prefix, year, sequence, company_profile_id, company_snapshot, order_date, needed_by_date, " +
  "vendor_name, vendor_contact_name, vendor_email, vendor_phone, vendor_account_number, " +
  "vendor_address_line1, vendor_address_line2, vendor_city, vendor_state, vendor_zip, vendor_country, " +
  "ship_to, payment_terms, shipping_method, freight_terms, reference_number, " +
  "prepared_by_name, authorized_by_name, authorized_by_title, buyer_phone, buyer_email, " +
  "shipping_cost, tax_exempt, tax_rate_percent, subtotal, tax_amount, total, " +
  "special_instructions, terms_text, notes_to_vendor, internal_notes, " +
  "deleted_at, last_downloaded_at, created_at, updated_at, created_by_account";

/** List rows, newest first. includeDeleted=false (the default) hides soft-deleted POs. */
export async function fetchPurchaseOrders(supabase: any, opts: { includeDeleted?: boolean } = {}): Promise<PurchaseOrder[]> {
  let query = supabase.from("purchase_orders").select(PO_COLUMNS).order("created_at", { ascending: false });
  if (!opts.includeDeleted) query = query.is("deleted_at", null);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as PurchaseOrder[];
}

export async function fetchPurchaseOrderWithLines(supabase: any, id: string): Promise<PurchaseOrderWithLines | null> {
  const { data, error } = await supabase
    .from("purchase_orders")
    .select(`${PO_COLUMNS}, po_lines(id, po_id, line_number, item_number, description, quantity, unit, unit_price, line_total)`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const lines = [...(data.po_lines ?? [])].sort((a: PoLine, b: PoLine) => a.line_number - b.line_number);
  return { ...data, po_lines: lines } as PurchaseOrderWithLines;
}

export async function softDeletePurchaseOrder(supabase: any, id: string): Promise<void> {
  const { error } = await supabase.from("purchase_orders").update({ deleted_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function restorePurchaseOrder(supabase: any, id: string): Promise<void> {
  const { error } = await supabase.from("purchase_orders").update({ deleted_at: null }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** The payload shape /api/purchase-orders (create) and /api/purchase-orders/[id] (update) expect. */
export type PoLineInput = {
  item_number: string;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
};

export type PoFormPayload = {
  company_profile_id: string;
  order_date: string;
  needed_by_date: string;
  vendor_name: string;
  vendor_contact_name: string;
  vendor_email: string;
  vendor_phone: string;
  vendor_account_number: string;
  vendor_address_line1: string;
  vendor_address_line2: string;
  vendor_city: string;
  vendor_state: string;
  vendor_zip: string;
  vendor_country: string;
  ship_to: ShipTo;
  payment_terms: string;
  shipping_method: string;
  freight_terms: string;
  reference_number: string;
  prepared_by_name: string;
  authorized_by_name: string;
  authorized_by_title: string;
  buyer_phone: string;
  buyer_email: string;
  shipping_cost: string;
  tax_exempt: boolean;
  tax_rate_percent: string;
  special_instructions: string;
  terms_text: string;
  notes_to_vendor: string;
  internal_notes: string;
  lines: PoLineInput[];
  refresh_company_snapshot?: boolean;
};

export async function createPurchaseOrder(
  token: string,
  payload: PoFormPayload,
): Promise<{ id: string; po_number: string }> {
  const res = await fetch("/api/purchase-orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to create this purchase order.");
  return body;
}

export async function updatePurchaseOrder(
  token: string,
  id: string,
  payload: PoFormPayload,
): Promise<{ id: string; po_number: string }> {
  const res = await fetch(`/api/purchase-orders/${id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to save changes to this purchase order.");
  return body;
}

/** Client-side preview of totals only — never what's actually saved; the RPC always recomputes server-side. */
export function previewTotals(lines: PoLineInput[], shippingCostStr: string, taxExempt: boolean, taxRatePercentStr: string) {
  let subtotal = 0;
  for (const line of lines) {
    const qty = Number(line.quantity);
    const price = Number(line.unit_price);
    if (Number.isFinite(qty) && Number.isFinite(price) && qty > 0 && price > 0) {
      subtotal += Math.round(qty * price * 100) / 100;
    }
  }
  const shipping = Number(shippingCostStr) || 0;
  const taxRate = Number(taxRatePercentStr) || 0;
  const taxAmount = taxExempt ? 0 : Math.round(subtotal * (taxRate / 100) * 100) / 100;
  const total = subtotal + shipping + taxAmount;
  return { subtotal, taxAmount, total };
}

export function formatMoney(amount: number | null | undefined): string {
  const n = Number(amount ?? 0);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export const EMPTY_PO_LINE: PoLineInput = { item_number: "", description: "", quantity: "", unit: "", unit_price: "" };

/** Fetches the generated PDF as a Blob — "inline" is a preview (never touches last_downloaded_at server-side), "attachment" is a real download. */
export async function fetchPurchaseOrderPdfBlob(token: string, id: string, disposition: "inline" | "attachment" = "attachment"): Promise<Blob> {
  const res = await fetch(`/api/purchase-orders/${id}/download?disposition=${disposition}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to generate the PDF.");
  }
  return res.blob();
}

/** Forces a browser "Save As" for an already-fetched blob, via a throwaway <a download>. */
export function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const PAYMENT_TERMS_OPTIONS = ["Net 30", "Net 60", "Due on receipt", "50% deposit, balance on delivery", "Prepaid"];
export const SHIPPING_METHOD_OPTIONS = ["Vendor-arranged ground", "Buyer-arranged pickup", "Expedited / air", "LTL freight", "Local delivery"];
export const FREIGHT_TERMS_OPTIONS = ["Prepaid and added to invoice", "Prepaid and allowed (FOB destination)", "Collect (FOB origin)", "Third-party billed"];
