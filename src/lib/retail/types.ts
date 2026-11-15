/**
 * Retail data shapes (Admin only): retailers, payment terms by business,
 * price lists, invoice settings and invoices. Tables are created by
 * supabase-migrations/retail_invoices.sql.
 */
import type { ConsignmentSchedule, DefaultTermsType, Terms, TermsStart, TermsType } from "./terms";

export type Retailer = {
  id: string;
  name: string;
  legal_name: string | null;
  description: string | null;
  website_url: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  billing_line1: string | null;
  billing_line2: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  billing_country: string | null;
  shipping_same_as_billing: boolean;
  shipping_name: string | null;
  shipping_line1: string | null;
  shipping_line2: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_zip: string | null;
  shipping_country: string | null;
  tax_exempt: boolean;
  resale_certificate_number: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by_name: string | null;
};

export type RetailerTermsRow = Terms & {
  id: string;
  retailer_id: string;
  company_profile_id: string;
  updated_at: string;
  updated_by_name: string | null;
};

export type RetailerPriceRow = {
  id: string;
  retailer_id: string;
  product_id: string;
  wholesale_price: number | string | null;
  msrp: number | string | null;
  notes: string | null;
  updated_at: string;
  updated_by_name: string | null;
};

export type InvoiceSettings = {
  id: string;
  company_profile_id: string;
  invoice_prefix: string;
  payable_to: string | null;
  remit_line1: string | null;
  remit_line2: string | null;
  remit_city: string | null;
  remit_state: string | null;
  remit_zip: string | null;
  remit_country: string | null;
  payment_instructions: string | null;
  default_terms_type: DefaultTermsType;
  default_net_days: number;
  default_tax_rate_percent: number | string;
  footer_note: string | null;
  product_scope: "botaniqals" | "minileaf" | "all";
  updated_at: string;
  updated_by_name: string | null;
};

/** Business (company profile) fields Retail needs. Edited on Purchase Order settings. */
export type Business = {
  id: string;
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
  archived_at: string | null;
};

export type RetailProduct = {
  id: string;
  name: string;
  unit: string | null;
  sale_price_per_unit: number | string | null;
  is_microgreen: boolean;
};

export type Address = {
  name: string;
  contact_name?: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
};

/** The letterhead as of the invoice: business profile plus invoice settings. */
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
  invoice_prefix: string;
  payable_to: string | null;
  remit_line1: string | null;
  remit_line2: string | null;
  remit_city: string | null;
  remit_state: string | null;
  remit_zip: string | null;
  remit_country: string | null;
  payment_instructions: string | null;
  footer_note: string | null;
};

export type RetailerSnapshot = {
  name: string;
  legal_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  billing_line1: string | null;
  billing_line2: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  billing_country: string | null;
  tax_exempt: boolean;
  resale_certificate_number: string | null;
};

export type InvoiceLine = {
  id?: string;
  line_number: number;
  product_id: string | null;
  description: string;
  quantity: number | string;
  unit: string;
  unit_price: number | string;
  line_total: number | string;
};

export type Invoice = {
  id: string;
  invoice_number: string;
  prefix: string;
  year: number;
  sequence: number;
  order_number: string;
  company_profile_id: string;
  company_snapshot: CompanySnapshot;
  retailer_id: string;
  retailer_snapshot: RetailerSnapshot;
  bill_to: Address;
  ship_to: Address;
  invoice_date: string;
  delivery_date: string;
  terms_type: TermsType;
  net_days: number | null;
  terms_start: TermsStart;
  consignment_our_share_percent: number | string | null;
  consignment_schedule: ConsignmentSchedule | null;
  consignment_days_to_pay: number | null;
  consignment_extra_terms: string | null;
  due_date: string | null;
  retailer_po_number: string | null;
  delivery_fee: number | string;
  tax_exempt: boolean;
  tax_rate_percent: number | string;
  subtotal: number | string;
  tax_amount: number | string;
  total: number | string;
  notes_to_retailer: string | null;
  internal_notes: string | null;
  deleted_at: string | null;
  last_downloaded_at: string | null;
  created_at: string;
  updated_at: string;
  created_by_name: string | null;
};

export type InvoiceWithLines = Invoice & { lines: InvoiceLine[] };

/** A row on the Invoices tab. */
export type InvoiceListRow = Pick<
  Invoice,
  | "id" | "invoice_number" | "order_number" | "company_profile_id" | "retailer_id" | "invoice_date" | "delivery_date" | "due_date"
  | "terms_type" | "net_days" | "total" | "created_by_name" | "deleted_at" | "last_downloaded_at" | "updated_at" | "retailer_po_number"
  | "consignment_our_share_percent" | "consignment_schedule"
> & { retailer_name: string; business_name: string };

export const RETAILER_COLUMNS =
  "id, name, legal_name, description, website_url, contact_name, contact_email, contact_phone, billing_line1, billing_line2, " +
  "billing_city, billing_state, billing_zip, billing_country, shipping_same_as_billing, shipping_name, shipping_line1, " +
  "shipping_line2, shipping_city, shipping_state, shipping_zip, shipping_country, tax_exempt, resale_certificate_number, notes, " +
  "archived_at, created_at, updated_at, updated_by_name";
export const TERMS_COLUMNS =
  "id, retailer_id, company_profile_id, terms_type, net_days, terms_start, consignment_our_share_percent, consignment_schedule, " +
  "consignment_days_to_pay, consignment_extra_terms, updated_at, updated_by_name";
export const PRICE_COLUMNS = "id, retailer_id, product_id, wholesale_price, msrp, notes, updated_at, updated_by_name";
export const SETTINGS_COLUMNS =
  "id, company_profile_id, invoice_prefix, payable_to, remit_line1, remit_line2, remit_city, remit_state, remit_zip, remit_country, " +
  "payment_instructions, default_terms_type, default_net_days, default_tax_rate_percent, footer_note, product_scope, updated_at, updated_by_name";
export const BUSINESS_COLUMNS =
  "id, display_name, legal_name, address_line1, address_line2, city, state, zip, country, phone, email, website, logo_path, accent_color, archived_at";
export const PRODUCT_COLUMNS = "id, name, unit, sale_price_per_unit, is_microgreen";
export const INVOICE_COLUMNS =
  "id, invoice_number, prefix, year, sequence, order_number, company_profile_id, company_snapshot, retailer_id, retailer_snapshot, " +
  "bill_to, ship_to, invoice_date, delivery_date, terms_type, net_days, terms_start, consignment_our_share_percent, " +
  "consignment_schedule, consignment_days_to_pay, consignment_extra_terms, due_date, retailer_po_number, delivery_fee, tax_exempt, " +
  "tax_rate_percent, subtotal, tax_amount, total, notes_to_retailer, internal_notes, deleted_at, last_downloaded_at, created_at, " +
  "updated_at, created_by_name";
export const LINE_COLUMNS = "id, line_number, product_id, description, quantity, unit, unit_price, line_total";

export const INVOICE_UNITS = ["each", "case", "pack", "tray", "box", "lb", "oz", "g", "kg"] as const;

/** Which products a business's invoices offer (products.is_microgreen marks MiniLeaf). */
export function productsForBusiness(products: readonly RetailProduct[], scope: InvoiceSettings["product_scope"] | null | undefined): RetailProduct[] {
  if (scope === "minileaf") return products.filter((p) => p.is_microgreen);
  if (scope === "botaniqals") return products.filter((p) => !p.is_microgreen);
  return [...products];
}

export const productBusinessLabel = (p: Pick<RetailProduct, "is_microgreen">) => (p.is_microgreen ? "MiniLeaf" : "BotanIQals");

export const RETAIL_NOTES_HINT = "Do not store passwords or card numbers here.";
export const PAYMENT_INSTRUCTIONS_HINT =
  "This prints on every invoice. Only enter information you are comfortable sending to customers, and never passwords or card numbers.";
export const CONSIGNMENT_EXTRA_HINT = "This prints on invoices. Have your terms reviewed before relying on them.";
export const CONSIGNMENT_TAX_HINT = "Tax usually applies when the retailer sells the goods. Check with your accountant.";
export const ORDER_NUMBER_HELP = "Enter the order number from the Shopify order for this sale. It prints on the invoice next to the ERP invoice number.";
export const ORDER_NUMBER_NOTE = "Orders with both BotanIQals and MiniLeaf products are separate Shopify orders, so each gets its own invoice.";
export const PRICE_LIST_NOTE = "MSRP is used as the retail price on consignment invoices; wholesale price is used on all other invoices.";
