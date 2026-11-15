/**
 * Retail server code (Admin only). Called from API routes that ran
 * guardApi() (every /api/retail route is registered as Admin in the feature
 * catalog) with the service-role client. Every input is validated here and
 * checked again by the database.
 *
 * Invoices are standalone documents: nothing here creates, reads or
 * changes Shopify orders, inventory, batches, Sales Data or Stats.
 */
import Decimal from "decimal.js";
import { computeDueDate } from "./dueDate";
import { sameOrderNumber, normalizeOrderNumber } from "./orderNumber";
import { buildCompanySnapshot, buildRetailerSnapshot } from "./snapshots";
import { computeTotals } from "./totals";
import { DEFAULT_DAYS_TO_PAY, type Terms } from "./terms";
import {
  BUSINESS_COLUMNS,
  INVOICE_COLUMNS,
  LINE_COLUMNS,
  PRICE_COLUMNS,
  PRODUCT_COLUMNS,
  RETAILER_COLUMNS,
  SETTINGS_COLUMNS,
  TERMS_COLUMNS,
  type Business,
  type Invoice,
  type InvoiceListRow,
  type InvoiceSettings,
  type InvoiceWithLines,
  type RetailProduct,
  type Retailer,
  type RetailerPriceRow,
  type RetailerTermsRow,
} from "./types";
import {
  isUuid,
  parseListPrice,
  validateInvoiceInput,
  validateRetailer,
  validateSettings,
  validateTermsByBusiness,
  type FieldErrors,
  type InvoiceInput,
} from "./validation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = { from: (table: string) => any; rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> };

export type OrderConflict = { id: string; invoice_number: string; business: string; retailer: string; order_number: string };

export class RetailError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
    public readonly fields?: FieldErrors,
    public readonly conflict?: OrderConflict,
  ) {
    super(message);
  }
}

function fail(error: { message: string } | null, fallback: string): never {
  const msg = error?.message ?? "";
  if (/retailers_name_unique/.test(msg)) throw new RetailError("A retailer with this name already exists.", 409, { name: "A retailer with this name already exists." });
  if (/invoices_order_number_active_unique/.test(msg)) throw new RetailError("That Shopify order number already has an invoice.", 409, { order_number: "That Shopify order number already has an invoice." });
  if (/check constraint|violates/.test(msg)) throw new RetailError(`Some details are not valid (${msg.replace(/^.*constraint "([^"]+)".*$/, "$1")}).`, 400);
  if (/at most 100 lines|at least one line|must be greater than 0|must be 0 or more/.test(msg)) throw new RetailError(msg, 400);
  throw new Error(msg ? `${fallback} (${msg})` : fallback);
}

const idOrThrow = (id: unknown, what: string): string => {
  if (!isUuid(id)) throw new RetailError(`Unknown ${what}.`, 404);
  return id;
};

const scopeFor = (b: Pick<Business, "display_name">): InvoiceSettings["product_scope"] => {
  const n = b.display_name.trim().toLowerCase();
  return n === "minileaf" ? "minileaf" : n === "botaniqals" ? "botaniqals" : "all";
};

// --- Lookups ----------------------------------------------------------------------------
async function businesses(db: Db): Promise<Business[]> {
  const { data, error } = await db.from("company_profiles").select(BUSINESS_COLUMNS).order("display_name", { ascending: true });
  if (error) fail(error, "Could not load businesses.");
  return data ?? [];
}

/** Every business has a settings row (blank defaults); creates any that are missing. */
export async function ensureSettings(db: Db): Promise<InvoiceSettings[]> {
  const [bs, s] = await Promise.all([businesses(db), db.from("invoice_settings").select(SETTINGS_COLUMNS)]);
  if (s.error) fail(s.error, "Could not load invoice settings.");
  const have = new Set((s.data ?? []).map((r: InvoiceSettings) => r.company_profile_id));
  const missing = bs.filter((b) => !have.has(b.id));
  if (missing.length === 0) return s.data ?? [];
  for (const b of missing) {
    const { error } = await db.from("invoice_settings").insert({ company_profile_id: b.id, product_scope: scopeFor(b) });
    if (error && !/duplicate key/.test(error.message)) fail(error, "Could not create invoice settings.");
  }
  const again = await db.from("invoice_settings").select(SETTINGS_COLUMNS);
  if (again.error) fail(again.error, "Could not load invoice settings.");
  return again.data ?? [];
}

async function activeProducts(db: Db): Promise<RetailProduct[]> {
  const { data, error } = await db.from("products").select(PRODUCT_COLUMNS).is("deleted_at", null).order("name", { ascending: true });
  if (error) fail(error, "Could not load products.");
  return (data ?? []).map((p: RetailProduct) => ({ ...p, is_microgreen: !!p.is_microgreen }));
}

async function getRetailer(db: Db, id: unknown): Promise<Retailer> {
  const rid = idOrThrow(id, "retailer");
  const { data, error } = await db.from("retailers").select(RETAILER_COLUMNS).eq("id", rid).maybeSingle();
  if (error) fail(error, "Could not load the retailer.");
  if (!data) throw new RetailError("Unknown retailer.", 404);
  return data;
}

async function getBusiness(db: Db, id: unknown): Promise<Business> {
  const bid = idOrThrow(id, "business");
  const { data, error } = await db.from("company_profiles").select(BUSINESS_COLUMNS).eq("id", bid).maybeSingle();
  if (error) fail(error, "Could not load the business.");
  if (!data) throw new RetailError("Unknown business.", 404);
  return data;
}

export type RetailBootstrap = {
  businesses: Business[];
  settings: InvoiceSettings[];
  retailers: Retailer[];
  terms: RetailerTermsRow[];
  products: RetailProduct[];
  invoiceStats: Record<string, { count: number; last_invoice_date: string | null }>;
};

/** Everything the Retail page, retailer editor and invoice form need. */
export async function loadRetailBootstrap(db: Db): Promise<RetailBootstrap> {
  const settings = await ensureSettings(db);
  const [bs, r, t, products, inv] = await Promise.all([
    businesses(db),
    db.from("retailers").select(RETAILER_COLUMNS).order("name", { ascending: true }),
    db.from("retailer_terms").select(TERMS_COLUMNS),
    activeProducts(db),
    db.from("invoices").select("retailer_id, invoice_date").is("deleted_at", null),
  ]);
  if (r.error) fail(r.error, "Could not load retailers.");
  if (t.error) fail(t.error, "Could not load payment terms.");
  if (inv.error) fail(inv.error, "Could not load invoices.");
  const invoiceStats: RetailBootstrap["invoiceStats"] = {};
  for (const row of (inv.data ?? []) as { retailer_id: string; invoice_date: string }[]) {
    const s = (invoiceStats[row.retailer_id] ??= { count: 0, last_invoice_date: null });
    s.count += 1;
    if (!s.last_invoice_date || row.invoice_date > s.last_invoice_date) s.last_invoice_date = row.invoice_date;
  }
  return { businesses: bs, settings, retailers: r.data ?? [], terms: t.data ?? [], products, invoiceStats };
}

// --- Retailers ----------------------------------------------------------------------------
async function saveTerms(db: Db, retailerId: string, termsInput: unknown, actorName: string | null) {
  if (termsInput === undefined) return;
  const active = (await businesses(db)).filter((b) => !b.archived_at).map((b) => b.id);
  const checked = validateTermsByBusiness(termsInput, active);
  if (!checked.ok) throw new RetailError("Some payment terms are not valid.", 400, checked.errors);
  for (const [businessId, t] of Object.entries(checked.value)) {
    if (t === null) {
      // "Use business default": no row for this business.
      const { error } = await db.from("retailer_terms").delete().eq("retailer_id", retailerId).eq("company_profile_id", businessId);
      if (error) fail(error, "Could not save payment terms.");
      continue;
    }
    const { error } = await db
      .from("retailer_terms")
      .upsert({ retailer_id: retailerId, company_profile_id: businessId, ...t, updated_by_name: actorName }, { onConflict: "retailer_id,company_profile_id" });
    if (error) fail(error, "Could not save payment terms.");
  }
}

export async function createRetailer(db: Db, body: { retailer?: unknown; terms?: unknown }, actorName: string | null): Promise<Retailer> {
  const r = validateRetailer(body.retailer);
  if (!r.ok) throw new RetailError("Some retailer details are not valid.", 400, r.errors);
  if (body.terms !== undefined) {
    const active = (await businesses(db)).filter((b) => !b.archived_at).map((b) => b.id);
    const t = validateTermsByBusiness(body.terms, active);
    if (!t.ok) throw new RetailError("Some payment terms are not valid.", 400, t.errors);
  }
  const { data, error } = await db.from("retailers").insert({ ...r.value, updated_by_name: actorName }).select(RETAILER_COLUMNS).single();
  if (error) fail(error, "Could not save the retailer.");
  await saveTerms(db, data.id, body.terms, actorName);
  return data;
}

export async function updateRetailer(db: Db, id: unknown, body: { retailer?: unknown; terms?: unknown }, actorName: string | null): Promise<Retailer> {
  const current = await getRetailer(db, id);
  if (current.archived_at) throw new RetailError("This retailer is archived. Restore it first.", 400);
  const r = validateRetailer(body.retailer);
  if (!r.ok) throw new RetailError("Some retailer details are not valid.", 400, r.errors);
  const { data, error } = await db.from("retailers").update({ ...r.value, updated_by_name: actorName }).eq("id", current.id).select(RETAILER_COLUMNS).single();
  if (error) fail(error, "Could not save the retailer.");
  await saveTerms(db, current.id, body.terms, actorName);
  return data;
}

export async function setRetailerArchived(db: Db, id: unknown, archived: boolean, actorName: string | null): Promise<Retailer> {
  const current = await getRetailer(db, id);
  if (!!current.archived_at === archived) throw new RetailError(archived ? "This retailer is already archived." : "This retailer is not archived.", 400);
  const { data, error } = await db
    .from("retailers")
    .update({ archived_at: archived ? new Date().toISOString() : null, updated_by_name: actorName })
    .eq("id", current.id)
    .select(RETAILER_COLUMNS)
    .single();
  if (error) fail(error, archived ? "Could not archive the retailer." : "Could not restore the retailer.");
  return data;
}

export type RetailerDetail = { retailer: Retailer; terms: RetailerTermsRow[]; prices: RetailerPriceRow[]; invoices: InvoiceListRow[] };

export async function loadRetailerDetail(db: Db, id: unknown): Promise<RetailerDetail> {
  const retailer = await getRetailer(db, id);
  const [t, p, invoices] = await Promise.all([
    db.from("retailer_terms").select(TERMS_COLUMNS).eq("retailer_id", retailer.id),
    db.from("retailer_prices").select(PRICE_COLUMNS).eq("retailer_id", retailer.id),
    listInvoices(db, { retailerId: retailer.id, includeDeleted: false, pageSize: 1000 }),
  ]);
  if (t.error) fail(t.error, "Could not load payment terms.");
  if (p.error) fail(p.error, "Could not load the price list.");
  return { retailer, terms: t.data ?? [], prices: p.data ?? [], invoices: invoices.rows };
}

// --- Price lists ------------------------------------------------------------------------------
export type PriceInput = { product_id: string; wholesale_price: string | null; msrp: string | null; notes: string | null };

function checkPriceRows(rows: unknown, productIds: Set<string>): { value: PriceInput[]; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const list = Array.isArray(rows) ? rows : [];
  const value: PriceInput[] = [];
  for (const r of list) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const pid = o.product_id;
    if (!isUuid(pid) || !productIds.has(pid)) {
      errors[`prices.${String(pid)}`] = "Unknown or deleted product.";
      continue;
    }
    const w = parseListPrice(o.wholesale_price);
    const m = parseListPrice(o.msrp);
    if (!w.ok) errors[`prices.${pid}.wholesale_price`] = w.error;
    if (!m.ok) errors[`prices.${pid}.msrp`] = m.error;
    const notes = typeof o.notes === "string" && o.notes.trim() ? o.notes.trim() : null;
    if (notes && notes.length > 500) errors[`prices.${pid}.notes`] = "Keep notes under 501 characters.";
    if (w.ok && m.ok) value.push({ product_id: pid, wholesale_price: w.value, msrp: m.value, notes });
  }
  return { value, errors };
}

export async function savePrices(db: Db, retailerId: unknown, rows: unknown, actorName: string | null): Promise<RetailerPriceRow[]> {
  const retailer = await getRetailer(db, retailerId);
  const products = new Set((await activeProducts(db)).map((p) => p.id));
  const { value, errors } = checkPriceRows(rows, products);
  if (Object.keys(errors).length > 0) throw new RetailError("Some prices are not valid.", 400, errors);
  if (value.length > 0) {
    const { error } = await db
      .from("retailer_prices")
      .upsert(value.map((v) => ({ retailer_id: retailer.id, ...v, updated_by_name: actorName })), { onConflict: "retailer_id,product_id" });
    if (error) fail(error, "Could not save the price list.");
  }
  const { data, error } = await db.from("retailer_prices").select(PRICE_COLUMNS).eq("retailer_id", retailer.id);
  if (error) fail(error, "Could not load the price list.");
  return data ?? [];
}

export type PriceChange = { product_id: string; product_name: string; field: "msrp" | "wholesale_price"; from: string | null; to: string };
export type PriceTool =
  | { tool: "fill_msrp" }
  | { tool: "fill_wholesale"; percent: unknown }
  | { tool: "copy"; source_retailer_id: unknown; overwrite?: boolean };

const dec = (v: unknown) => (v === null || v === undefined || v === "" ? null : new Decimal(String(v)));

/**
 * The three price list helpers. Returns the changes they would make (a
 * preview); writes them only when apply is true.
 */
export async function runPriceTool(db: Db, retailerId: unknown, tool: PriceTool, apply: boolean, actorName: string | null): Promise<PriceChange[]> {
  const retailer = await getRetailer(db, retailerId);
  const products = await activeProducts(db);
  const { data: current, error } = await db.from("retailer_prices").select(PRICE_COLUMNS).eq("retailer_id", retailer.id);
  if (error) fail(error, "Could not load the price list.");
  const byProduct = new Map<string, RetailerPriceRow>((current ?? []).map((r: RetailerPriceRow) => [r.product_id, r]));
  const changes: PriceChange[] = [];

  if (tool.tool === "fill_msrp") {
    for (const p of products) {
      const sale = dec(p.sale_price_per_unit);
      const row = byProduct.get(p.id);
      if (!sale || sale.lte(0) || dec(row?.msrp)) continue;
      changes.push({ product_id: p.id, product_name: p.name, field: "msrp", from: null, to: sale.toDecimalPlaces(4).toFixed() });
    }
  } else if (tool.tool === "fill_wholesale") {
    const pct = typeof tool.percent === "number" ? tool.percent : Number(tool.percent);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new RetailError("Enter a percentage greater than 0 and up to 100.", 400, { percent: "Enter a percentage greater than 0 and up to 100." });
    for (const p of products) {
      const row = byProduct.get(p.id);
      const msrp = dec(row?.msrp);
      if (!msrp || msrp.lte(0) || dec(row?.wholesale_price)) continue;
      changes.push({
        product_id: p.id,
        product_name: p.name,
        field: "wholesale_price",
        from: null,
        to: msrp.times(pct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      });
    }
  } else if (tool.tool === "copy") {
    const source = await getRetailer(db, tool.source_retailer_id);
    if (source.id === retailer.id) throw new RetailError("Choose a different retailer to copy from.", 400);
    const { data: src, error: srcError } = await db.from("retailer_prices").select(PRICE_COLUMNS).eq("retailer_id", source.id);
    if (srcError) fail(srcError, "Could not load the other retailer's prices.");
    const srcBy = new Map<string, RetailerPriceRow>((src ?? []).map((r: RetailerPriceRow) => [r.product_id, r]));
    for (const p of products) {
      const s = srcBy.get(p.id);
      if (!s) continue;
      const row = byProduct.get(p.id);
      for (const field of ["msrp", "wholesale_price"] as const) {
        const to = dec(s[field]);
        const from = dec(row?.[field]);
        if (!to) continue;
        if (from && !tool.overwrite) continue;
        if (from && from.eq(to)) continue;
        changes.push({ product_id: p.id, product_name: p.name, field, from: from ? from.toFixed() : null, to: to.toFixed() });
      }
    }
  } else {
    throw new RetailError("Unknown price tool.", 400);
  }

  if (apply && changes.length > 0) {
    const merged = new Map<string, { retailer_id: string; product_id: string; wholesale_price: string | null; msrp: string | null; notes: string | null; updated_by_name: string | null }>();
    for (const c of changes) {
      const row = byProduct.get(c.product_id);
      const m = merged.get(c.product_id) ?? {
        retailer_id: retailer.id,
        product_id: c.product_id,
        wholesale_price: row?.wholesale_price === null || row?.wholesale_price === undefined ? null : String(row.wholesale_price),
        msrp: row?.msrp === null || row?.msrp === undefined ? null : String(row.msrp),
        notes: row?.notes ?? null,
        updated_by_name: actorName,
      };
      m[c.field] = c.to;
      merged.set(c.product_id, m);
    }
    const { error: upError } = await db.from("retailer_prices").upsert([...merged.values()], { onConflict: "retailer_id,product_id" });
    if (upError) fail(upError, "Could not update the price list.");
  }
  return changes;
}

// --- Invoice settings --------------------------------------------------------------------------
export async function saveSettings(db: Db, businessId: unknown, input: unknown, actorName: string | null): Promise<InvoiceSettings> {
  const b = await getBusiness(db, businessId);
  await ensureSettings(db);
  const v = validateSettings(input);
  if (!v.ok) throw new RetailError("Some settings are not valid.", 400, v.errors);
  const { data, error } = await db
    .from("invoice_settings")
    .update({ ...v.value, updated_by_name: actorName })
    .eq("company_profile_id", b.id)
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) fail(error, "Could not save invoice settings.");
  return data;
}

// --- Invoices -------------------------------------------------------------------------------------
export type InvoiceFilters = {
  q?: string;
  businessId?: string;
  retailerId?: string;
  termsType?: string;
  from?: string;
  to?: string;
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
};

const LIST_COLUMNS =
  "id, invoice_number, prefix, year, sequence, order_number, company_profile_id, retailer_id, invoice_date, delivery_date, due_date, terms_type, net_days, " +
  "consignment_our_share_percent, consignment_schedule, total, created_by_name, deleted_at, last_downloaded_at, updated_at, retailer_po_number";

/** Newest invoice number first (year, then sequence), 20 per page by default. */
export async function listInvoices(db: Db, f: InvoiceFilters): Promise<{ rows: InvoiceListRow[]; total: number; page: number; pageSize: number }> {
  const [inv, r, b] = await Promise.all([
    db.from("invoices").select(LIST_COLUMNS),
    db.from("retailers").select("id, name"),
    db.from("company_profiles").select("id, display_name"),
  ]);
  if (inv.error) fail(inv.error, "Could not load invoices.");
  const retailerName = new Map<string, string>((r.data ?? []).map((x: { id: string; name: string }) => [x.id, x.name]));
  const businessName = new Map<string, string>((b.data ?? []).map((x: { id: string; display_name: string }) => [x.id, x.display_name]));
  const q = (f.q ?? "").trim().toLowerCase();
  const rows = ((inv.data ?? []) as (InvoiceListRow & { year: number; sequence: number; prefix: string })[])
    .map((x) => ({ ...x, retailer_name: retailerName.get(x.retailer_id) ?? "", business_name: businessName.get(x.company_profile_id) ?? "" }))
    .filter((x) => (f.includeDeleted ? true : !x.deleted_at))
    .filter((x) => !f.businessId || x.company_profile_id === f.businessId)
    .filter((x) => !f.retailerId || x.retailer_id === f.retailerId)
    .filter((x) => !f.termsType || x.terms_type === f.termsType)
    .filter((x) => !f.from || x.invoice_date >= f.from)
    .filter((x) => !f.to || x.invoice_date <= f.to)
    .filter(
      (x) =>
        !q ||
        x.invoice_number.toLowerCase().includes(q) ||
        x.order_number.toLowerCase().includes(q) ||
        x.order_number.toLowerCase().replace(/^#/, "") === q.replace(/^#/, "") ||
        x.retailer_name.toLowerCase().includes(q) ||
        (x.retailer_po_number ?? "").toLowerCase().includes(q),
    )
    .sort((a, b) => b.year - a.year || b.sequence - a.sequence || a.prefix.localeCompare(b.prefix));
  const pageSize = Math.min(Math.max(f.pageSize ?? 20, 1), 1000);
  const page = Math.max(f.page ?? 1, 1);
  return {
    rows: rows.slice((page - 1) * pageSize, page * pageSize).map((x) => {
      const { year: _y, sequence: _s, prefix: _p, ...rest } = x;
      void _y;
      void _s;
      void _p;
      return rest;
    }),
    total: rows.length,
    page,
    pageSize,
  };
}

export async function getInvoice(db: Db, id: unknown): Promise<InvoiceWithLines> {
  const iid = idOrThrow(id, "invoice");
  const { data, error } = await db.from("invoices").select(INVOICE_COLUMNS).eq("id", iid).maybeSingle();
  if (error) fail(error, "Could not load the invoice.");
  if (!data) throw new RetailError("Unknown invoice.", 404);
  const { data: lines, error: lError } = await db.from("invoice_lines").select(LINE_COLUMNS).eq("invoice_id", iid).order("line_number", { ascending: true });
  if (lError) fail(lError, "Could not load the invoice lines.");
  return { ...(data as Invoice), lines: lines ?? [] };
}

/** The active invoice that already uses this Shopify order number (case-insensitive), if any. */
export async function findOrderConflict(db: Db, orderNumber: unknown, excludeId?: string | null): Promise<OrderConflict | null> {
  const n = normalizeOrderNumber(orderNumber);
  if (!n.ok) return null;
  const { data, error } = await db.from("invoices").select("id, invoice_number, order_number, company_profile_id, retailer_id").is("deleted_at", null);
  if (error) fail(error, "Could not check the order number.");
  const hit = ((data ?? []) as { id: string; invoice_number: string; order_number: string; company_profile_id: string; retailer_id: string }[]).find(
    (x) => x.id !== excludeId && sameOrderNumber(x.order_number, n.value),
  );
  if (!hit) return null;
  const [b, r] = await Promise.all([
    db.from("company_profiles").select("display_name").eq("id", hit.company_profile_id).maybeSingle(),
    db.from("retailers").select("name").eq("id", hit.retailer_id).maybeSingle(),
  ]);
  return { id: hit.id, invoice_number: hit.invoice_number, order_number: hit.order_number, business: b.data?.display_name ?? "", retailer: r.data?.name ?? "" };
}

export const conflictMessage = (c: OrderConflict) => `Order ${c.order_number} already has an invoice (${c.invoice_number}, ${c.business}, ${c.retailer}).`;

/** Everything the database needs for create_invoice / update_invoice, built from checked input. */
async function prepareInvoice(db: Db, input: InvoiceInput, opts: { existing: InvoiceWithLines | null; actorName: string | null }) {
  const business = await getBusiness(db, input.company_profile_id);
  const retailer = await getRetailer(db, input.retailer_id);
  const changingRetailer = !opts.existing || opts.existing.retailer_id !== retailer.id;
  if (retailer.archived_at && changingRetailer) throw new RetailError("That retailer is archived. Restore it or choose another.", 400, { retailer_id: "That retailer is archived." });
  if (business.archived_at && (!opts.existing || opts.existing.company_profile_id !== business.id)) {
    throw new RetailError("That business is archived.", 400, { company_profile_id: "That business is archived." });
  }
  const productIds = input.lines.map((l) => l.product_id).filter((p): p is string => !!p);
  if (productIds.length > 0) {
    const { data, error } = await db.from("products").select("id").in("id", [...new Set(productIds)]);
    if (error) fail(error, "Could not check the products.");
    const found = new Set((data ?? []).map((p: { id: string }) => p.id));
    const missing = productIds.find((p) => !found.has(p));
    if (missing) throw new RetailError("A line refers to an unknown product.", 400, { lines: "A line refers to an unknown product." });
  }
  const conflict = await findOrderConflict(db, input.order_number, opts.existing?.id ?? null);
  if (conflict) throw new RetailError(conflictMessage(conflict), 409, { order_number: conflictMessage(conflict) }, conflict);

  const settings = (await ensureSettings(db)).find((s) => s.company_profile_id === business.id) ?? null;
  const t = input.terms;
  const due_date = computeDueDate(input.invoice_date, input.delivery_date, t.terms_type, t.net_days, t.terms_start);
  const snapshots =
    !opts.existing || input.refresh_snapshots || opts.existing.company_profile_id !== business.id || opts.existing.retailer_id !== retailer.id
      ? { company_snapshot: buildCompanySnapshot(business, settings), retailer_snapshot: buildRetailerSnapshot(retailer) }
      : {};
  return {
    business,
    retailer,
    payload: {
      order_number: input.order_number,
      company_profile_id: business.id,
      retailer_id: retailer.id,
      ...snapshots,
      bill_to: input.bill_to,
      ship_to: input.ship_to,
      invoice_date: input.invoice_date,
      delivery_date: input.delivery_date,
      terms_type: t.terms_type,
      net_days: t.net_days,
      terms_start: t.terms_start,
      consignment_our_share_percent: t.consignment_our_share_percent,
      consignment_schedule: t.consignment_schedule,
      consignment_days_to_pay: t.consignment_days_to_pay,
      consignment_extra_terms: t.consignment_extra_terms,
      due_date,
      retailer_po_number: input.retailer_po_number,
      delivery_fee: input.delivery_fee,
      tax_exempt: input.tax_exempt,
      tax_rate_percent: input.tax_exempt ? "0" : input.tax_rate_percent,
      notes_to_retailer: input.notes_to_retailer,
      internal_notes: input.internal_notes,
      created_by_name: opts.actorName,
      lines: input.lines.map((l) => ({ product_id: l.product_id, description: l.description, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price })),
    },
  };
}

function checkedInput(body: unknown): InvoiceInput {
  const v = validateInvoiceInput(body);
  if (!v.ok) throw new RetailError("Some invoice details are missing or not valid.", 400, v.errors);
  return v.value;
}

/** Ticked "Save this price to the price list" lines (never on consignment invoices). */
async function savePricesFromLines(db: Db, input: InvoiceInput, actorName: string | null) {
  if (input.terms.terms_type === "consignment") return;
  const rows = input.lines.filter((l) => l.save_to_price_list && l.product_id);
  if (rows.length === 0) return;
  const { data: current } = await db.from("retailer_prices").select(PRICE_COLUMNS).eq("retailer_id", input.retailer_id);
  const by = new Map<string, RetailerPriceRow>((current ?? []).map((r: RetailerPriceRow) => [r.product_id, r]));
  const upserts = new Map<string, Record<string, unknown>>();
  for (const l of rows) {
    const row = by.get(l.product_id!);
    upserts.set(l.product_id!, {
      retailer_id: input.retailer_id,
      product_id: l.product_id,
      wholesale_price: l.unit_price,
      msrp: row?.msrp ?? null,
      notes: row?.notes ?? null,
      updated_by_name: actorName,
    });
  }
  const { error } = await db.from("retailer_prices").upsert([...upserts.values()], { onConflict: "retailer_id,product_id" });
  if (error) fail(error, "The invoice was saved, but its prices could not be saved to the price list.");
}

/** Creates an invoice. The database assigns the ERP invoice number in the same transaction. */
export async function createInvoice(db: Db, body: unknown, actorName: string | null): Promise<{ id: string; invoice_number: string }> {
  const input = checkedInput(body);
  const { payload } = await prepareInvoice(db, input, { existing: null, actorName });
  const { data, error } = await db.rpc("create_invoice", { payload });
  if (error) fail(error, "Could not save the invoice.");
  const result = (typeof data === "string" ? JSON.parse(data) : data) as { id: string; invoice_number: string };
  await savePricesFromLines(db, input, actorName);
  return result;
}

/** Updates an invoice. Its ERP number never changes; snapshots change only on request (or a new business/retailer). */
export async function updateInvoice(db: Db, id: unknown, body: unknown, actorName: string | null): Promise<{ id: string; invoice_number: string }> {
  const existing = await getInvoice(db, id);
  if (existing.deleted_at) throw new RetailError("This invoice is deleted. Restore it before editing.", 400);
  const input = checkedInput(body);
  const { payload } = await prepareInvoice(db, input, { existing, actorName });
  const { created_by_name: _ignored, ...rest } = payload;
  void _ignored;
  const { data, error } = await db.rpc("update_invoice", { p_id: existing.id, payload: rest });
  if (error) fail(error, "Could not save the invoice.");
  await savePricesFromLines(db, input, actorName);
  return (typeof data === "string" ? JSON.parse(data) : data) as { id: string; invoice_number: string };
}

export async function setInvoiceDeleted(db: Db, id: unknown, deleted: boolean): Promise<Invoice> {
  const inv = await getInvoice(db, id);
  if (!!inv.deleted_at === deleted) throw new RetailError(deleted ? "This invoice is already deleted." : "This invoice is not deleted.", 400);
  if (!deleted) {
    const conflict = await findOrderConflict(db, inv.order_number, inv.id);
    if (conflict) {
      throw new RetailError(
        `${inv.invoice_number} can't be restored: order ${inv.order_number} is used by ${conflict.invoice_number} (${conflict.business}, ${conflict.retailer}). Delete that invoice or change its order number first.`,
        409,
        undefined,
        conflict,
      );
    }
  }
  const { data, error } = await db
    .from("invoices")
    .update({ deleted_at: deleted ? new Date().toISOString() : null })
    .eq("id", inv.id)
    .select(INVOICE_COLUMNS)
    .single();
  if (error) fail(error, deleted ? "Could not delete the invoice." : "Could not restore the invoice.");
  return data;
}

export async function markDownloaded(db: Db, id: string): Promise<void> {
  await db.from("invoices").update({ last_downloaded_at: new Date().toISOString() }).eq("id", id);
}

/**
 * An unsaved invoice shaped like a saved one, for "Preview PDF". Totals use
 * the same math as the database. Nothing is written and no number is used.
 */
export async function buildPreviewInvoice(db: Db, body: unknown, existingId?: string | null): Promise<InvoiceWithLines> {
  const input = checkedInput(body);
  const existing = existingId ? await getInvoice(db, existingId) : null;
  const business = await getBusiness(db, input.company_profile_id);
  const retailer = await getRetailer(db, input.retailer_id);
  const settings = (await ensureSettings(db)).find((s) => s.company_profile_id === business.id) ?? null;
  const t = input.terms;
  const totals = computeTotals(input.lines, input.delivery_fee, input.tax_exempt ? "0" : input.tax_rate_percent, input.tax_exempt);
  const keepSnapshots = existing && !input.refresh_snapshots && existing.company_profile_id === business.id && existing.retailer_id === retailer.id;
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? "preview",
    invoice_number: existing?.invoice_number ?? "Assigned when saved",
    prefix: settings?.invoice_prefix ?? "KCG-INV",
    year: 0,
    sequence: 0,
    order_number: input.order_number,
    company_profile_id: business.id,
    company_snapshot: keepSnapshots ? existing!.company_snapshot : buildCompanySnapshot(business, settings),
    retailer_id: retailer.id,
    retailer_snapshot: keepSnapshots ? existing!.retailer_snapshot : buildRetailerSnapshot(retailer),
    bill_to: input.bill_to,
    ship_to: input.ship_to,
    invoice_date: input.invoice_date,
    delivery_date: input.delivery_date,
    ...t,
    due_date: computeDueDate(input.invoice_date, input.delivery_date, t.terms_type, t.net_days, t.terms_start),
    retailer_po_number: input.retailer_po_number,
    delivery_fee: totals.deliveryFee,
    tax_exempt: input.tax_exempt,
    tax_rate_percent: input.tax_exempt ? "0" : input.tax_rate_percent,
    subtotal: totals.subtotal,
    tax_amount: totals.tax,
    total: totals.total,
    notes_to_retailer: input.notes_to_retailer,
    internal_notes: input.internal_notes,
    deleted_at: null,
    last_downloaded_at: null,
    created_at: now,
    updated_at: now,
    created_by_name: null,
    lines: input.lines.map((l, i) => ({
      line_number: i + 1,
      product_id: l.product_id,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unit_price: l.unit_price,
      line_total: totals.lineTotals[i],
    })),
  };
}

/** Default consignment fields when switching an invoice to consignment with nothing to prefill from. */
export const EMPTY_CONSIGNMENT: Pick<Terms, "consignment_our_share_percent" | "consignment_schedule" | "consignment_days_to_pay" | "consignment_extra_terms"> = {
  consignment_our_share_percent: null,
  consignment_schedule: "monthly",
  consignment_days_to_pay: DEFAULT_DAYS_TO_PAY,
  consignment_extra_terms: null,
};
