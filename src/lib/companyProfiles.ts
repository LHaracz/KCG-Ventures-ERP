/**
 * Shared types + fetch helpers for Purchase Orders' company profiles
 * (BotanIQals, MiniLeaf, and any future business added via "New business
 * profile"). Mirrors employees.ts's shape: a thin query helper, not a full
 * data-access layer — pages still talk to Supabase directly for CRUD, since
 * RLS already permits any authenticated user full select/insert/update
 * (see purchase_orders_core.sql). There is deliberately no delete helper —
 * profiles are archived (archived_at set via an ordinary update), never
 * deleted, because POs reference them by id forever.
 */

export type ShipToDefault = {
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

export type CompanyProfile = {
  id: string;
  display_name: string;
  legal_name: string;
  po_prefix: string;
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
  default_buyer_name: string | null;
  default_buyer_title: string | null;
  default_buyer_phone: string | null;
  default_buyer_email: string | null;
  default_payment_terms: string | null;
  default_shipping_method: string | null;
  default_freight_terms: string | null;
  default_special_instructions: string | null;
  default_terms_text: string | null;
  footer_note: string | null;
  ship_to_default: ShipToDefault;
  archived_at: string | null;
  created_at: string;
};

export const EMPTY_SHIP_TO_DEFAULT: ShipToDefault = {
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

export const COMPANY_PROFILE_COLUMNS =
  "id, display_name, legal_name, po_prefix, address_line1, address_line2, city, state, zip, country, phone, email, website, logo_path, accent_color, default_buyer_name, default_buyer_title, default_buyer_phone, default_buyer_email, default_payment_terms, default_shipping_method, default_freight_terms, default_special_instructions, default_terms_text, footer_note, ship_to_default, archived_at, created_at";

export async function fetchAllCompanyProfiles(supabase: any): Promise<CompanyProfile[]> {
  const { data, error } = await supabase
    .from("company_profiles")
    .select(COMPANY_PROFILE_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as CompanyProfile[];
}

export async function fetchActiveCompanyProfiles(supabase: any): Promise<CompanyProfile[]> {
  const profiles = await fetchAllCompanyProfiles(supabase);
  return profiles.filter((p) => !p.archived_at);
}

export function companyProfileDisplayAddress(profile: CompanyProfile): string {
  const line2 = profile.address_line2 ? ` ${profile.address_line2}` : "";
  const cityStateZip = [profile.city, profile.state].filter(Boolean).join(", ") + (profile.zip ? ` ${profile.zip}` : "");
  const parts = [profile.address_line1 ? `${profile.address_line1}${line2}` : null, cityStateZip.trim() || null, profile.country || null].filter(
    Boolean,
  );
  return parts.join(", ");
}
