"use client";

/**
 * The invoice form (new, edit and duplicate). Prices come from the
 * retailer's price list (wholesale; MSRP on consignment), terms from the
 * retailer's terms for the business or the business default, and Bill to /
 * Ship to from the retailer. Everything stays editable. Totals here are a
 * preview: the database computes the stored totals and the invoice number.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Decimal from "decimal.js";
import {
  checkOrderApi,
  createInvoiceApi,
  previewPdfBlob,
  RetailApiError,
  updateInvoiceApi,
} from "@/lib/retail/client";
import { computeDueDate, isIsoDate, isValidNetDays } from "@/lib/retail/dueDate";
import { formatLongDate, formatMoney, formatUnitPrice, todayNy, toDecimal } from "@/lib/retail/format";
import { normalizeOrderNumber } from "@/lib/retail/orderNumber";
import { billToFromRetailer, shipToFromRetailer } from "@/lib/retail/snapshots";
import { resolveDefaultTerms, type Terms } from "@/lib/retail/terms";
import { computeTotals, linePriceFor } from "@/lib/retail/totals";
import {
  CONSIGNMENT_TAX_HINT,
  INVOICE_UNITS,
  ORDER_NUMBER_HELP,
  ORDER_NUMBER_NOTE,
  RETAIL_NOTES_HINT,
  productBusinessLabel,
  productsForBusiness,
  type Address,
  type InvoiceWithLines,
  type Retailer,
  type RetailerPriceRow,
} from "@/lib/retail/types";
import { MAX_INVOICE_LINES, validateInvoiceInput } from "@/lib/retail/validation";
import type { OrderConflict, RetailBootstrap } from "@/lib/retail/service";
import { fetchRetailerDetail } from "@/lib/retail/client";
import {
  AddressFields,
  Checkbox,
  Dialog,
  ErrorSummary,
  FieldError,
  Hint,
  Select,
  TermsFields,
  TextArea,
  TextField,
  btn,
  btnDanger,
  btnPrimary,
  card,
  draftToTerms,
  infoBox,
  input,
  termsToDraft,
  warnBox,
  type TermsDraft,
} from "./RetailUi";

const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), {
  ssr: false,
  loading: () => <p className="p-4 text-xs text-black">Loading preview…</p>,
});

type LineDraft = { key: string; product_id: string; description: string; quantity: string; unit: string; unit_price: string; save: boolean };

let keySeq = 0;
const newKey = () => `l${++keySeq}`;
const blankLine = (): LineDraft => ({ key: newKey(), product_id: "", description: "", quantity: "1", unit: "each", unit_price: "", save: false });
const num = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? "" : new Decimal(v).toFixed());
const EMPTY_ADDRESS: Address = { name: "", line1: "", line2: "", city: "", state: "", zip: "", country: "" };

export type InvoiceFormMode = { kind: "new"; retailerId?: string | null } | { kind: "edit"; invoice: InvoiceWithLines } | { kind: "duplicate"; source: InvoiceWithLines };

export function InvoiceForm({ boot, mode }: { boot: RetailBootstrap; mode: InvoiceFormMode }) {
  const router = useRouter();
  const editing = mode.kind === "edit" ? mode.invoice : null;
  const source = mode.kind === "edit" ? mode.invoice : mode.kind === "duplicate" ? mode.source : null;

  const businesses = useMemo(() => boot.businesses.filter((b) => !b.archived_at || b.id === source?.company_profile_id), [boot.businesses, source]);
  const retailers = useMemo(
    () => boot.retailers.filter((r) => !r.archived_at || (editing && r.id === editing.retailer_id)).sort((a, b) => a.name.localeCompare(b.name)),
    [boot.retailers, editing],
  );

  const today = todayNy();
  const initialRetailerId =
    source && retailers.some((r) => r.id === source.retailer_id) ? source.retailer_id : mode.kind === "new" && mode.retailerId && retailers.some((r) => r.id === mode.retailerId) ? mode.retailerId : "";
  const [businessId, setBusinessId] = useState<string>(source && businesses.some((b) => b.id === source.company_profile_id) ? source.company_profile_id : businesses[0]?.id ?? "");
  const [retailerId, setRetailerId] = useState<string>(initialRetailerId);
  const [orderNumber, setOrderNumber] = useState<string>(editing ? editing.order_number : "");
  const [invoiceDate, setInvoiceDate] = useState<string>(editing ? editing.invoice_date : today);
  const [deliveryDate, setDeliveryDate] = useState<string>(editing ? editing.delivery_date : today);
  const [poNumber, setPoNumber] = useState<string>(editing?.retailer_po_number ?? "");
  const [terms, setTerms] = useState<TermsDraft>(() => (source ? termsToDraft(source) : { ...termsToDraft(null), terms_type: "net" }));
  const [termsSource, setTermsSource] = useState<"retailer" | "business_default" | "invoice">(source ? "invoice" : "business_default");
  const [deliveryFee, setDeliveryFee] = useState<string>(source ? num(source.delivery_fee) : "0");
  const [taxExempt, setTaxExempt] = useState<boolean>(source ? source.tax_exempt : false);
  const [taxRate, setTaxRate] = useState<string>(source ? num(source.tax_rate_percent) : "0");
  const [billTo, setBillTo] = useState<Address>(source ? source.bill_to : EMPTY_ADDRESS);
  const [shipTo, setShipTo] = useState<Address>(source ? source.ship_to : EMPTY_ADDRESS);
  const [notesToRetailer, setNotesToRetailer] = useState<string>(source?.notes_to_retailer ?? "");
  const [internalNotes, setInternalNotes] = useState<string>(source?.internal_notes ?? "");
  const [refreshSnapshots, setRefreshSnapshots] = useState(false);
  const [lines, setLines] = useState<LineDraft[]>(() =>
    source && source.lines.length > 0
      ? source.lines.map((l) => ({ key: newKey(), product_id: l.product_id ?? "", description: l.description, quantity: num(l.quantity), unit: l.unit, unit_price: num(l.unit_price), save: false }))
      : [blankLine()],
  );
  const [prices, setPrices] = useState<RetailerPriceRow[]>([]);
  const [pricesFor, setPricesFor] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "preview" | null>(null);
  const [orderCheck, setOrderCheck] = useState<{ value: string; conflict: OrderConflict | null; message: string | null } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [reprice, setReprice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const business = businesses.find((b) => b.id === businessId) ?? null;
  const retailer: Retailer | null = retailers.find((r) => r.id === retailerId) ?? boot.retailers.find((r) => r.id === retailerId) ?? null;
  const settings = boot.settings.find((s) => s.company_profile_id === businessId) ?? null;
  const consignment = terms.terms_type === "consignment";
  const products = useMemo(() => productsForBusiness(boot.products, settings?.product_scope), [boot.products, settings]);
  const productById = useMemo(() => new Map(boot.products.map((p) => [p.id, p])), [boot.products]);
  const priceBy = useMemo(() => new Map(prices.map((p) => [p.product_id, p])), [prices]);
  const touch = () => setDirty(true);

  // Load the retailer's price list whenever the retailer changes.
  useEffect(() => {
    let cancelled = false;
    if (!retailerId) {
      setPrices([]);
      setPricesFor(null);
      return;
    }
    fetchRetailerDetail(retailerId)
      .then((d) => {
        if (cancelled) return;
        setPrices(d.prices);
        setPricesFor(retailerId);
      })
      .catch(() => {
        if (cancelled) return;
        setPrices([]);
        setPricesFor(retailerId);
      });
    return () => {
      cancelled = true;
    };
  }, [retailerId]);

  /** Terms, tax and addresses for a business + retailer (new invoices, or when either changes). */
  const applyDefaults = useCallback(
    (bId: string, r: Retailer | null, opts: { addresses: boolean }) => {
      const s = boot.settings.find((x) => x.company_profile_id === bId) ?? null;
      const rt = r ? boot.terms.find((t) => t.retailer_id === r.id && t.company_profile_id === bId) ?? null : null;
      const resolved = resolveDefaultTerms(rt, s);
      setTerms({ ...termsToDraft(resolved), terms_type: resolved.terms_type });
      setTermsSource(resolved.source);
      const exempt = !!r?.tax_exempt;
      setTaxExempt(exempt);
      setTaxRate(exempt || resolved.terms_type === "consignment" ? "0" : num(s?.default_tax_rate_percent ?? 0) || "0");
      if (r && opts.addresses) {
        setBillTo(billToFromRetailer(r));
        setShipTo(shipToFromRetailer(r));
      }
    },
    [boot.settings, boot.terms],
  );

  // New invoice with a preselected retailer: fill defaults once.
  const filledOnce = useRef(false);
  useEffect(() => {
    if (filledOnce.current || source) return;
    filledOnce.current = true;
    applyDefaults(businessId, retailer, { addresses: true });
  }, [applyDefaults, businessId, retailer, source]);

  const changeBusiness = (id: string) => {
    setBusinessId(id);
    touch();
    applyDefaults(id, retailer, { addresses: false });
    if (lines.some((l) => l.product_id)) setReprice("The business changed, so the terms may have changed.");
  };
  const changeRetailer = (id: string) => {
    setRetailerId(id);
    touch();
    const r = boot.retailers.find((x) => x.id === id) ?? null;
    applyDefaults(businessId, r, { addresses: true });
    if (lines.some((l) => l.product_id)) setReprice("The retailer changed.");
  };
  const changeTerms = (d: TermsDraft) => {
    const wasConsignment = terms.terms_type === "consignment";
    const isConsignment = d.terms_type === "consignment";
    setTerms(d);
    setTermsSource("invoice");
    touch();
    if (wasConsignment !== isConsignment) {
      if (isConsignment) setTaxRate("0");
      else if (!taxExempt) setTaxRate(num(settings?.default_tax_rate_percent ?? 0) || "0");
      if (lines.some((l) => l.product_id)) setReprice(isConsignment ? "Consignment invoices use the retail price (MSRP)." : "Invoices that aren't consignment use the wholesale price.");
    }
  };

  // Lines whose price differs from what the list says for these terms.
  const listPrice = (productId: string) => (productId ? linePriceFor(consignment ? "consignment" : "net", priceBy.get(productId)) : null);
  const repriceChanges = lines.filter((l) => {
    const p = listPrice(l.product_id);
    return p !== null && toDecimal(l.unit_price)?.toFixed() !== new Decimal(p).toFixed();
  });
  // Price list arrives after the retailer changes: drop the prompt when nothing would change.
  const pricesReady = !!retailerId && pricesFor === retailerId;
  useEffect(() => {
    if (reprice && pricesReady && repriceChanges.length === 0) setReprice(null);
  }, [reprice, pricesReady, repriceChanges.length]);

  const applyReprice = () => {
    setLines((ls) => ls.map((l) => {
      const p = listPrice(l.product_id);
      return p !== null ? { ...l, unit_price: p, save: false } : l;
    }));
    setReprice(null);
  };

  // Debounced order number check.
  useEffect(() => {
    const n = normalizeOrderNumber(orderNumber);
    if (!n.ok) {
      setOrderCheck(null);
      return;
    }
    const t = setTimeout(() => {
      checkOrderApi(n.value, editing?.id ?? null)
        .then((r) => setOrderCheck({ value: n.value, conflict: r.conflict, message: r.message }))
        .catch(() => setOrderCheck(null));
    }, 400);
    return () => clearTimeout(t);
  }, [orderNumber, editing]);

  const setLine = (key: string, patch: Partial<LineDraft>) => {
    touch();
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const chooseProduct = (key: string, productId: string) => {
    const p = productById.get(productId);
    const price = listPrice(productId);
    setLine(key, {
      product_id: productId,
      description: p ? p.name : "",
      unit: p?.unit && INVOICE_UNITS.includes(p.unit.toLowerCase() as never) ? p.unit.toLowerCase() : "each",
      unit_price: price ?? "",
      save: false,
    });
  };
  const move = (i: number, d: -1 | 1) => {
    touch();
    setLines((ls) => {
      const next = [...ls];
      const j = i + d;
      if (j < 0 || j >= next.length) return ls;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const totals = useMemo(() => {
    const ok = (v: string) => (toDecimal(v) ? v : "0");
    return computeTotals(
      lines.map((l) => ({ quantity: ok(l.quantity), unit_price: ok(l.unit_price) })),
      ok(deliveryFee),
      taxExempt ? "0" : ok(taxRate),
      taxExempt,
    );
  }, [lines, deliveryFee, taxRate, taxExempt]);

  const dueText = (() => {
    if (consignment) return "No due date (consignment).";
    if (!isIsoDate(invoiceDate) || !isIsoDate(deliveryDate)) return "";
    if (terms.terms_type === "prepaid") return `Due before delivery (${formatLongDate(invoiceDate)}).`;
    const days = Number(terms.net_days);
    if (terms.terms_type === "net" && !isValidNetDays(days)) return "";
    try {
      const due = computeDueDate(invoiceDate, deliveryDate, terms.terms_type as Terms["terms_type"], terms.terms_type === "net" ? days : null, terms.terms_start);
      return due ? `Due ${formatLongDate(due)}.` : "";
    } catch {
      return "";
    }
  })();

  const payload = () => ({
    company_profile_id: businessId,
    retailer_id: retailerId,
    order_number: orderNumber,
    invoice_date: invoiceDate,
    delivery_date: deliveryDate,
    retailer_po_number: poNumber,
    terms: draftToTerms(terms),
    delivery_fee: deliveryFee || "0",
    tax_exempt: taxExempt,
    tax_rate_percent: taxExempt ? "0" : taxRate || "0",
    bill_to: billTo,
    ship_to: shipTo,
    notes_to_retailer: notesToRetailer,
    internal_notes: internalNotes,
    refresh_snapshots: refreshSnapshots,
    lines: lines.map((l) => ({ product_id: l.product_id || null, description: l.description, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, save_to_price_list: l.save })),
  });

  const check = (): boolean => {
    const v = validateInvoiceInput(payload());
    const errs = v.ok ? {} : { ...v.errors };
    if (orderCheck?.conflict && orderCheck.message) errs.order_number = orderCheck.message;
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      setMessage("Please fix the items below.");
      return false;
    }
    setMessage(null);
    return true;
  };

  const save = async () => {
    if (!check()) return;
    setBusy("save");
    try {
      const res = editing ? await updateInvoiceApi(editing.id, payload()) : await createInvoiceApi(payload());
      setDirty(false);
      router.push(`/fulfillment/retail/invoices/${res.id}${editing ? "" : "?created=1"}`);
    } catch (e) {
      const err = e as RetailApiError;
      setMessage(err.message);
      if (err.fields) setErrors(err.fields);
      setBusy(null);
    }
  };

  const showPreview = async () => {
    if (!check()) return;
    setBusy("preview");
    try {
      const blob = await previewPdfBlob(payload(), editing?.id ?? null);
      setPreview(URL.createObjectURL(blob));
    } catch (e) {
      const err = e as RetailApiError;
      setMessage(err.message);
      if (err.fields) setErrors(err.fields);
    } finally {
      setBusy(null);
    }
  };
  const closePreview = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
  };

  // Leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [dirty]);

  // Warnings: never block saving.
  const warnings: string[] = [];
  if (retailer?.archived_at) warnings.push(`${retailer.name} is archived.`);
  const zero = lines.filter((l) => toDecimal(l.unit_price)?.isZero());
  if (zero.length > 0) warnings.push(`${zero.length} line${zero.length === 1 ? " has" : "s have"} a price of $0.00.`);
  const notInScope = lines.filter((l) => l.product_id && !products.some((p) => p.id === l.product_id));
  if (notInScope.length > 0 && business) warnings.push(`${notInScope.length} line${notInScope.length === 1 ? " is" : "s are"} not a ${business.display_name} product. ${ORDER_NUMBER_NOTE}`);
  const noList = pricesReady ? lines.filter((l) => l.product_id && listPrice(l.product_id) === null) : [];
  if (noList.length > 0) warnings.push(`${noList.length} product${noList.length === 1 ? " has" : "s have"} no ${consignment ? "MSRP" : "wholesale price"} on this retailer's price list.`);
  if (consignment && !taxExempt && toDecimal(taxRate)?.gt(0)) warnings.push(`Tax is set on a consignment invoice. ${CONSIGNMENT_TAX_HINT}`);
  if (editing?.last_downloaded_at) warnings.push(`This invoice was downloaded ${new Date(editing.last_downloaded_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}. After saving, download it again so the retailer gets the new version.`);
  if (isIsoDate(invoiceDate) && invoiceDate > today) warnings.push("The invoice date is in the future.");

  const e = (k: string) => errors[k];
  const productOptions = (current: string) => {
    const list = products.some((p) => p.id === current) || !current ? products : [...products, ...(productById.get(current) ? [productById.get(current)!] : [])];
    return [{ value: "", label: "Custom line (no product)" }, ...list.map((p) => ({ value: p.id, label: settings?.product_scope === "all" ? `${p.name} (${productBusinessLabel(p)})` : p.name }))];
  };
  const priceLabel = consignment ? "Retail price" : "Unit price";
  const orderLink = orderCheck?.conflict ? `/fulfillment/retail/invoices/${orderCheck.conflict.id}` : null;

  return (
    <div className="space-y-4 text-black">
      <ErrorSummary message={message} errors={errors} />

      <section className={`${card} space-y-3`}>
        <h2 className="text-sm font-semibold">Order</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Select
            name="business"
            label="Business"
            value={businessId}
            onChange={changeBusiness}
            required
            options={[{ value: "", label: "Choose…" }, ...businesses.map((b) => ({ value: b.id, label: b.display_name }))]}
            error={e("company_profile_id")}
          />
          <Select
            name="retailer"
            label="Retailer"
            value={retailerId}
            onChange={changeRetailer}
            required
            options={[{ value: "", label: "Choose…" }, ...retailers.map((r) => ({ value: r.id, label: r.archived_at ? `${r.name} (archived)` : r.name }))]}
            error={e("retailer_id")}
            hint={
              retailers.length === 0 ? (
                <>
                  No retailers yet. <Link href="/fulfillment/retail" className="underline">Add one on the Retailers tab.</Link>
                </>
              ) : undefined
            }
          />
          <div>
            <TextField
              name="order_number"
              label="Shopify order #"
              value={orderNumber}
              onChange={(v) => {
                touch();
                setOrderNumber(v);
              }}
              required
              placeholder="#1001"
              error={e("order_number")}
              hint={ORDER_NUMBER_HELP}
            />
            {orderCheck?.conflict && !e("order_number") && (
              <p className="mt-1 text-[11px] text-red-700" role="alert">
                {orderCheck.message}{" "}
                {orderLink && (
                  <Link href={orderLink} className="underline">
                    Open it
                  </Link>
                )}
              </p>
            )}
          </div>
          <TextField name="invoice_date" label="Invoice date" type="date" value={invoiceDate} onChange={(v) => { touch(); setInvoiceDate(v); }} required error={e("invoice_date")} />
          <TextField name="delivery_date" label="Delivery date" type="date" value={deliveryDate} onChange={(v) => { touch(); setDeliveryDate(v); }} required error={e("delivery_date")} />
          <TextField name="retailer_po" label="Retailer PO # (optional)" value={poNumber} onChange={(v) => { touch(); setPoNumber(v); }} error={e("retailer_po_number")} />
        </div>
        {editing && (
          <Checkbox
            name="refresh_snapshots"
            label="Update the business letterhead and retailer details to their current versions"
            checked={refreshSnapshots}
            onChange={(v) => { touch(); setRefreshSnapshots(v); }}
            hint="Off: the invoice keeps the details it was made with. Bill to and Ship to below are always saved as shown."
          />
        )}
      </section>

      <section className={`${card} space-y-2`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Payment terms</h2>
          <span className="text-xs">
            {termsSource === "retailer" ? "From this retailer's terms" : termsSource === "business_default" ? "Business default" : "Set on this invoice"}
          </span>
        </div>
        <TermsFields idPrefix="inv-terms" draft={terms} onChange={changeTerms} errors={errors} errorPrefix="terms." />
        {dueText && <p className="text-xs">{dueText}</p>}
        {consignment && <p className={infoBox}>Consignment invoices list the retail value of the goods left with the retailer. No payment is due on delivery. The ERP does not track consignment stock, sales or settlements.</p>}
      </section>

      {reprice && pricesReady && repriceChanges.length > 0 && (
        <div className={warnBox} role="status">
          <p>
            {reprice} {repriceChanges.length} line{repriceChanges.length === 1 ? "" : "s"} could use the {consignment ? "MSRP" : "wholesale price"} from the price list.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={btnPrimary} onClick={applyReprice}>
              Update {repriceChanges.length} price{repriceChanges.length === 1 ? "" : "s"}
            </button>
            <button type="button" className={btn} onClick={() => setReprice(null)}>
              Keep current prices
            </button>
          </div>
        </div>
      )}

      <section className={`${card} space-y-2`}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Lines</h2>
          <span className="text-xs">
            {lines.length} of {MAX_INVOICE_LINES}
          </span>
        </div>
        <FieldError msg={e("lines")} />
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-zinc-50">
              <tr>
                <th className="px-1 py-2 font-semibold">Product</th>
                <th className="px-1 py-2 font-semibold">Description</th>
                <th className="px-1 py-2 font-semibold">Qty</th>
                <th className="px-1 py-2 font-semibold">Unit</th>
                <th className="px-1 py-2 font-semibold">{priceLabel}</th>
                <th className="px-1 py-2 text-right font-semibold">{consignment ? "Retail value" : "Amount"}</th>
                <th className="px-1 py-2">
                  <span className="sr-only">Line actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const n = i + 1;
                const list = listPrice(l.product_id);
                const differs = !consignment && l.product_id && toDecimal(l.unit_price) && (list === null || new Decimal(list).toFixed() !== toDecimal(l.unit_price)!.toFixed());
                const lineErrs = ["product_id", "description", "quantity", "unit", "unit_price"].map((k) => e(`lines.${n}.${k}`)).filter(Boolean);
                return (
                  <tr key={l.key} className="border-t border-zinc-100 align-top">
                    <td className="px-1 py-1.5">
                      <select aria-label={`Line ${n} product`} value={l.product_id} onChange={(ev) => chooseProduct(l.key, ev.target.value)} className={`${input} w-48`}>
                        {productOptions(l.product_id).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1 py-1.5">
                      <input aria-label={`Line ${n} description`} value={l.description} onChange={(ev) => setLine(l.key, { description: ev.target.value })} className={`${input} w-64 ${e(`lines.${n}.description`) ? "border-red-500" : ""}`} />
                    </td>
                    <td className="px-1 py-1.5">
                      <input aria-label={`Line ${n} quantity`} inputMode="decimal" value={l.quantity} onChange={(ev) => setLine(l.key, { quantity: ev.target.value })} className={`${input} w-20 ${e(`lines.${n}.quantity`) ? "border-red-500" : ""}`} />
                    </td>
                    <td className="px-1 py-1.5">
                      <input aria-label={`Line ${n} unit`} list="invoice-units" value={l.unit} onChange={(ev) => setLine(l.key, { unit: ev.target.value })} className={`${input} w-20 ${e(`lines.${n}.unit`) ? "border-red-500" : ""}`} />
                    </td>
                    <td className="px-1 py-1.5">
                      <input aria-label={`Line ${n} ${priceLabel.toLowerCase()}`} inputMode="decimal" value={l.unit_price} onChange={(ev) => setLine(l.key, { unit_price: ev.target.value })} placeholder="0.00" className={`${input} w-24 ${e(`lines.${n}.unit_price`) ? "border-red-500" : ""}`} />
                      {l.product_id && list !== null && <p className="mt-0.5 text-[11px]">List: {formatUnitPrice(list)}</p>}
                      {differs && (
                        <label className="mt-0.5 flex items-center gap-1 text-[11px]">
                          <input type="checkbox" checked={l.save} onChange={(ev) => setLine(l.key, { save: ev.target.checked })} />
                          Save to price list
                        </label>
                      )}
                    </td>
                    <td className="px-1 py-1.5 text-right font-medium">{formatMoney(totals.lineTotals[i])}</td>
                    <td className="whitespace-nowrap px-1 py-1.5">
                      <div className="flex gap-1">
                        <button type="button" className={btn} aria-label={`Move line ${n} up`} onClick={() => move(i, -1)} disabled={i === 0}>
                          ↑
                        </button>
                        <button type="button" className={btn} aria-label={`Move line ${n} down`} onClick={() => move(i, 1)} disabled={i === lines.length - 1}>
                          ↓
                        </button>
                        <button type="button" className={btnDanger} aria-label={`Remove line ${n}`} onClick={() => { touch(); setLines((ls) => ls.filter((x) => x.key !== l.key)); }} disabled={lines.length === 1}>
                          Remove
                        </button>
                      </div>
                      {lineErrs.length > 0 && (
                        <ul className="mt-1 text-[11px] text-red-700" role="alert">
                          {lineErrs.map((m) => (
                            <li key={m}>{m}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <datalist id="invoice-units">
            {INVOICE_UNITS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </div>
        <button type="button" className={btn} onClick={() => { touch(); setLines((ls) => [...ls, blankLine()]); }} disabled={lines.length >= MAX_INVOICE_LINES}>
          Add line
        </button>
        {!consignment && <Hint>Tick “Save to price list” to keep a changed price as this retailer&apos;s wholesale price.</Hint>}
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className={`${card} space-y-2`}>
          <h2 className="text-sm font-semibold">Fees and tax</h2>
          <TextField name="delivery_fee" label="Delivery fee" value={deliveryFee} onChange={(v) => { touch(); setDeliveryFee(v); }} inputMode="decimal" error={e("delivery_fee")} hint="Not taxed." />
          <Checkbox name="tax_exempt" label="Tax exempt (resale)" checked={taxExempt} onChange={(v) => { touch(); setTaxExempt(v); if (v) setTaxRate("0"); }} />
          {!taxExempt && (
            <TextField
              name="tax_rate"
              label="Sales tax rate (%)"
              value={taxRate}
              onChange={(v) => { touch(); setTaxRate(v); }}
              inputMode="decimal"
              error={e("tax_rate_percent")}
              hint={consignment ? CONSIGNMENT_TAX_HINT : "Applies to the subtotal only."}
            />
          )}
        </div>
        <div className={`${card} space-y-1 text-xs`}>
          <h2 className="text-sm font-semibold">Totals (preview)</h2>
          <Row label="Subtotal" value={formatMoney(totals.subtotal)} />
          {toDecimal(totals.deliveryFee)?.gt(0) && <Row label="Delivery fee" value={formatMoney(totals.deliveryFee)} />}
          {!taxExempt && toDecimal(taxRate)?.gt(0) && <Row label={`Tax (${new Decimal(taxRate).toFixed()}%)`} value={formatMoney(totals.tax)} />}
          <div className="mt-1 border-t border-zinc-200 pt-1">
            <Row label={consignment ? "Total consigned value (retail)" : "Total"} value={formatMoney(totals.total)} bold />
          </div>
          <p className="pt-1 text-[11px]">The saved totals are calculated by the database the same way.</p>
        </div>
      </section>

      <section className={`${card} grid grid-cols-1 gap-4 md:grid-cols-2`}>
        <AddressFields prefix="bill_to" title="Bill to" value={billTo} onChange={(a) => { touch(); setBillTo(a); }} errors={errors} withContact />
        <div className="space-y-2">
          <AddressFields prefix="ship_to" title="Ship to" value={shipTo} onChange={(a) => { touch(); setShipTo(a); }} errors={errors} />
          {retailer && (
            <button type="button" className={btn} onClick={() => { touch(); setBillTo(billToFromRetailer(retailer)); setShipTo(shipToFromRetailer(retailer)); }}>
              Reset both from the retailer
            </button>
          )}
        </div>
      </section>

      <section className={`${card} grid grid-cols-1 gap-4 md:grid-cols-2`}>
        <TextArea name="notes_to_retailer" label="Notes to retailer (prints on the invoice)" value={notesToRetailer} onChange={(v) => { touch(); setNotesToRetailer(v); }} error={e("notes_to_retailer")} />
        <TextArea name="internal_notes" label="Internal notes (never printed)" value={internalNotes} onChange={(v) => { touch(); setInternalNotes(v); }} error={e("internal_notes")} hint={RETAIL_NOTES_HINT} />
      </section>

      {warnings.length > 0 && (
        <div className={warnBox} role="status">
          <p className="font-medium">Check before saving</p>
          <ul className="mt-1 list-disc pl-4">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 bg-white py-3">
        <p className="text-xs">
          {editing ? (
            <>
              Invoice number {editing.invoice_number} stays the same.
            </>
          ) : (
            "The invoice number is assigned when you save."
          )}
        </p>
        <div className="flex gap-2">
          <Link href={editing ? `/fulfillment/retail/invoices/${editing.id}` : "/fulfillment/retail?tab=invoices"} className={btn}>
            Cancel
          </Link>
          <button type="button" className={btn} onClick={showPreview} disabled={busy !== null}>
            {busy === "preview" ? "Making preview…" : "Preview PDF"}
          </button>
          <button type="button" className={btnPrimary} onClick={save} disabled={busy !== null}>
            {busy === "save" ? "Saving…" : editing ? "Save changes" : "Save invoice"}
          </button>
        </div>
      </div>

      {preview && (
        <Dialog title="Preview (not saved)" onClose={closePreview} wide>
          <p className="mb-2 text-xs text-black">This is how the PDF will look. Nothing is saved{editing ? "" : " and no invoice number is used"} until you save.</p>
          <div className="h-[70vh] overflow-hidden rounded-md border border-zinc-200">
            <PdfViewer fileUrl={preview} />
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "text-sm font-semibold" : ""}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
