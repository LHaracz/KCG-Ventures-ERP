/**
 * Procurement data shapes and labels (suppliers, which suppliers sell each
 * raw material, and how to pay them). Shared by the pages, the server routes
 * and the tests. Tables: suppliers, raw_material_suppliers
 * (supabase-migrations/procurement_suppliers.sql).
 */
import { PAYMENT_TERMS_OPTIONS } from "@/lib/purchaseOrders";

export const PAYMENT_METHODS = [
  { value: "credit_card", label: "Credit card (online checkout)", short: "Credit card" },
  { value: "wire_transfer", label: "Wire transfer", short: "Wire" },
  { value: "phone_order", label: "Phone order", short: "Phone order" },
  { value: "po_required", label: "Purchase order required", short: "PO required" },
  { value: "invoice_terms", label: "Invoice / net terms", short: "Invoice / net terms" },
  { value: "other", label: "Other", short: "Other" },
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["value"];
export const PAYMENT_METHOD_VALUES: readonly string[] = PAYMENT_METHODS.map((m) => m.value);
export const paymentMethodLabel = (v: string) => PAYMENT_METHODS.find((m) => m.value === v)?.short ?? v;

export const COA_POLICIES = [
  { value: "included", label: "Provided automatically" },
  { value: "request", label: "Must request" },
  { value: "not_available", label: "Not available" },
  { value: "unknown", label: "Unknown" },
] as const;
export type CoaPolicy = (typeof COA_POLICIES)[number]["value"];
export const COA_POLICY_VALUES: readonly string[] = COA_POLICIES.map((c) => c.value);
export const coaPolicyLabel = (v: string) => COA_POLICIES.find((c) => c.value === v)?.label ?? "Unknown";

/** Same list as the Purchase Order form's payment terms. */
export const SUPPLIER_PAYMENT_TERMS: readonly string[] = PAYMENT_TERMS_OPTIONS;

export const NOTES_HINT = "Do not store passwords or card numbers here.";

export type Supplier = {
  id: string;
  name: string;
  website_url: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  account_number: string | null;
  payment_methods: string[];
  payment_notes: string | null;
  ordering_notes: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  default_po_payment_terms: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by_name: string | null;
};

export type SupplierLink = {
  id: string;
  raw_material_id: string;
  supplier_id: string;
  is_preferred: boolean;
  product_url: string | null;
  supplier_item: string | null;
  pack_info: string | null;
  coa_policy: string;
  notes: string | null;
  link_updated_at: string | null;
  /** USD, numeric(14,4). Raw material POs never prefill it (it may be per a different unit). */
  price: number | string | null;
  price_note: string | null;
  price_updated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EquipmentCategory = {
  id: string;
  name: string;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
};

export type EquipmentItem = {
  id: string;
  name: string;
  category_id: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by_name: string | null;
};

/** One equipment item and supplier pair (equipment_suppliers). No COA. */
export type EquipmentLink = {
  id: string;
  equipment_id: string;
  supplier_id: string;
  is_preferred: boolean;
  product_url: string | null;
  /** Model or part number. */
  supplier_item: string | null;
  price: number | string | null;
  price_note: string | null;
  price_updated_at: string | null;
  notes: string | null;
  link_updated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RawMaterial = {
  id: string;
  name: string;
  unit: string | null;
  quantity_on_hand: number | string | null;
  par_level: number | string | null;
};

export type ProcurementData = {
  materials: RawMaterial[];
  suppliers: Supplier[];
  /** Active raw material listings. */
  links: SupplierLink[];
  /** Every category (archived included), by sort order. */
  categories: EquipmentCategory[];
  /** Every equipment item (archived included). */
  equipment: EquipmentItem[];
  /** Active equipment listings. */
  equipmentLinks: EquipmentLink[];
};

export type ProcurementTab = "raw" | "equipment";
/** "/inventory/procurement" or "/inventory/procurement?tab=equipment". */
export function procurementHref(tab: string | null | undefined, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (tab === "equipment") p.set("tab", "equipment");
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const q = p.toString();
  return q ? `/inventory/procurement?${q}` : "/inventory/procurement";
}

export const SUPPLIER_COLUMNS =
  "id, name, website_url, contact_name, contact_email, contact_phone, account_number, payment_methods, " +
  "payment_notes, ordering_notes, address_line1, address_line2, city, state, zip, country, " +
  "default_po_payment_terms, archived_at, created_at, updated_at, updated_by_name";

export const LINK_COLUMNS =
  "id, raw_material_id, supplier_id, is_preferred, product_url, supplier_item, pack_info, coa_policy, notes, " +
  "link_updated_at, price, price_note, price_updated_at, archived_at, created_at, updated_at";

export const CATEGORY_COLUMNS = "id, name, sort_order, archived_at, created_at";
export const EQUIPMENT_COLUMNS = "id, name, category_id, description, archived_at, created_at, updated_at, updated_by_name";
export const EQUIPMENT_LINK_COLUMNS =
  "id, equipment_id, supplier_id, is_preferred, product_url, supplier_item, price, price_note, price_updated_at, notes, " +
  "link_updated_at, archived_at, created_at, updated_at";

export const MATERIAL_COLUMNS = "id, name, unit, quantity_on_hand, par_level";
