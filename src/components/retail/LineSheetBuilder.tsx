"use client";

/**
 * Line sheet builder (Admin only): business, who it's for, price basis,
 * up to 60 products (descriptions and photos from the Marketing Hub
 * profiles), terms and contact. Preview PDF, Save, and Save & Download.
 */
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Checkbox, Dialog, ErrorSummary, Select, TextArea, TextField, btn, btnPrimary, card, errorBox, infoBox, input, warnBox } from "./RetailUi";
import { saveBlob, type RetailApiError } from "@/lib/retail/client";
import { createLineSheetApi, lineSheetPdfBlob, lineSheetPreviewBlob, updateLineSheetApi } from "@/lib/retail/lineSheetClient";
import type { LineSheetBuilderData } from "@/lib/retail/lineSheetService";
import { DEFAULT_WHOLESALE_PERCENT, MAX_LINE_SHEET_LINES, NO_PRICE_TEXT, lineSheetFilename, marginPercent, standardWholesale, type LineSheetWithLines, type PriceBasis } from "@/lib/retail/lineSheets";
import { formatLongDate, formatUnitPrice } from "@/lib/retail/format";
import { termsLabel, termsSummary } from "@/lib/retail/terms";
import { productsForBusiness, type RetailProduct } from "@/lib/retail/types";
import { scanText } from "@/lib/growth/text";
import { nyDateOf } from "@/lib/growth/dates";

const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), { ssr: false, loading: () => <p className="p-4 text-xs text-black">Loading…</p> });

type Line = {
  key: string;
  product_id: string | null;
  name: string;
  description: string;
  size_text: string;
  case_pack_text: string;
  wholesale_price: string;
  msrp: string;
  photo_asset_id: string | null;
};
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
let seq = 0;
const key = () => `l${++seq}`;

export function LineSheetBuilder({ data, sheet, preparedFor = "" }: { data: LineSheetBuilderData; sheet: LineSheetWithLines | null; preparedFor?: string }) {
  const router = useRouter();
  const businesses = data.businesses.filter((b) => !b.archived_at || b.id === sheet?.company_profile_id);
  const retailers = data.retailers.filter((r) => !r.archived_at || r.id === sheet?.retailer_id);
  const [v, setV] = useState(() => {
    const b = businesses.find((x) => x.id === sheet?.company_profile_id) ?? businesses[0];
    return {
      name: sheet?.name ?? "",
      company_profile_id: b?.id ?? "",
      retailer_id: sheet?.retailer_id ?? "",
      prepared_for: sheet ? sheet.prepared_for ?? "" : preparedFor,
      price_basis: (sheet?.price_basis ?? "standard") as PriceBasis,
      standard_wholesale_percent: str(sheet?.standard_wholesale_percent ?? DEFAULT_WHOLESALE_PERCENT),
      show_margin: sheet?.show_margin ?? false,
      minimum_order_text: sheet?.minimum_order_text ?? "",
      lead_time_text: sheet?.lead_time_text ?? "",
      payment_terms_text: sheet?.payment_terms_text ?? "",
      contact_name: sheet ? sheet.contact_name ?? "" : b?.display_name ?? "",
      contact_email: sheet ? sheet.contact_email ?? "" : b?.email ?? "",
      contact_phone: sheet ? sheet.contact_phone ?? "" : b?.phone ?? "",
      notes: sheet?.notes ?? "",
    };
  });
  const [lines, setLines] = useState<Line[]>(() =>
    (sheet?.lines ?? []).map((l) => ({
      key: key(),
      product_id: l.product_id,
      name: l.name,
      description: l.description ?? "",
      size_text: l.size_text ?? "",
      case_pack_text: l.case_pack_text ?? "",
      wholesale_price: str(l.wholesale_price),
      msrp: str(l.msrp),
      photo_asset_id: l.photo_asset_id,
    })),
  );
  const [termsTouched, setTermsTouched] = useState(!!sheet);
  const [refreshed, setRefreshed] = useState(false);
  const [picker, setPicker] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const settings = data.settings.find((s) => s.company_profile_id === v.company_profile_id);
  const products = useMemo(() => productsForBusiness(data.products, settings?.product_scope), [data.products, settings]);
  const marketing = useMemo(() => new Map(data.marketing.map((m) => [m.product_id, m])), [data.marketing]);

  const termsFor = (businessId: string, retailerId: string) => {
    const t = data.terms.find((x) => x.retailer_id === retailerId && x.company_profile_id === businessId);
    if (t) return termsSummary(t);
    const s = data.settings.find((x) => x.company_profile_id === businessId);
    return s ? termsLabel({ terms_type: s.default_terms_type, net_days: s.default_net_days }) : "";
  };
  const pricesFor = (p: RetailProduct | undefined, basis: PriceBasis, retailerId: string, percent: string) => {
    if (!p) return { wholesale_price: "", msrp: "" };
    if (basis === "retailer") {
      const rp = data.prices.find((x) => x.retailer_id === retailerId && x.product_id === p.id);
      return { wholesale_price: str(rp?.wholesale_price), msrp: str(rp?.msrp) };
    }
    const msrp = str(p.sale_price_per_unit);
    return { msrp, wholesale_price: standardWholesale(msrp, percent) ?? "" };
  };
  const repriceAll = (basis: PriceBasis, retailerId: string, percent: string) =>
    setLines((ls) => ls.map((l) => (l.product_id ? { ...l, ...pricesFor(data.products.find((p) => p.id === l.product_id), basis, retailerId, percent) } : l)));

  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const setBusiness = (id: string) => {
    const b = businesses.find((x) => x.id === id);
    setV((s) => ({
      ...s,
      company_profile_id: id,
      contact_name: b?.display_name ?? s.contact_name,
      contact_email: b?.email ?? "",
      contact_phone: b?.phone ?? "",
      payment_terms_text: termsTouched ? s.payment_terms_text : termsFor(id, s.retailer_id),
    }));
  };
  const setRetailer = (id: string) => {
    setV((s) => ({ ...s, retailer_id: id, payment_terms_text: termsTouched ? s.payment_terms_text : termsFor(s.company_profile_id, id) }));
    if (v.price_basis === "retailer") repriceAll("retailer", id, v.standard_wholesale_percent);
  };
  const setBasis = (b: string) => {
    const basis = b === "retailer" ? "retailer" : "standard";
    setV((s) => ({ ...s, price_basis: basis }));
    repriceAll(basis, v.retailer_id, v.standard_wholesale_percent);
  };
  const setPercent = (x: string) => {
    setV((s) => ({ ...s, standard_wholesale_percent: x }));
    if (v.price_basis === "standard") repriceAll("standard", v.retailer_id, x);
  };
  const addProducts = (ids: string[]) => {
    const add = ids
      .map((id) => data.products.find((p) => p.id === id))
      .filter((p): p is RetailProduct => !!p)
      .map((p) => {
        const m = marketing.get(p.id);
        return {
          key: key(),
          product_id: p.id,
          name: p.name,
          description: m?.description ?? "",
          size_text: "",
          case_pack_text: "",
          photo_asset_id: m?.photo_asset_id ?? null,
          ...pricesFor(p, v.price_basis, v.retailer_id, v.standard_wholesale_percent),
        };
      });
    setLines((ls) => [...ls, ...add].slice(0, MAX_LINE_SHEET_LINES));
  };
  const setLine = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const move = (i: number, d: number) =>
    setLines((ls) => {
      const j = i + d;
      if (j < 0 || j >= ls.length) return ls;
      const next = [...ls];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const body = (refresh: boolean) => ({
    ...v,
    retailer_id: v.retailer_id || null,
    refresh_prices: refresh,
    lines: lines.map(({ key: _k, ...l }) => {
      void _k;
      return l;
    }),
  });
  const fail = (e: unknown) => {
    setMessage((e as Error).message);
    setErrors((e as RetailApiError).fields ?? {});
  };
  const doPreview = async () => {
    setBusy("preview");
    setMessage(null);
    try {
      const blob = await lineSheetPreviewBlob(body(refreshed), sheet?.id ?? null);
      setPreview(URL.createObjectURL(blob));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const save = async (download: boolean) => {
    setBusy(download ? "download" : "save");
    setMessage(null);
    setErrors({});
    try {
      const { id } = sheet ? await updateLineSheetApi(sheet.id, body(refreshed)) : await createLineSheetApi(body(true));
      if (download) saveBlob(await lineSheetPdfBlob(id, false), lineSheetFilename(v.name));
      router.push(`/fulfillment/retail/line-sheets/${id}`);
    } catch (e) {
      fail(e);
      setBusy(null);
    }
  };

  const risky = [...new Set(lines.flatMap((l) => scanText(l.description, data.riskyWords).map((m) => m.phrase)))];
  const retailer = data.retailers.find((r) => r.id === v.retailer_id);
  return (
    <div className="space-y-4 text-black">
      <ErrorSummary message={message} errors={errors} />
      {sheet && !refreshed && (
        <div className={`${warnBox} flex flex-wrap items-center justify-between gap-2`} data-testid="prices-saved-warning">
          <span>Prices were saved on {formatLongDate(nyDateOf(sheet.prices_saved_at))}. They don&apos;t change when price lists or products change.</span>
          <button
            type="button"
            className={btn}
            onClick={() => {
              repriceAll(v.price_basis, v.retailer_id, v.standard_wholesale_percent);
              setRefreshed(true);
            }}
          >
            Refresh prices
          </button>
        </div>
      )}
      {refreshed && <p className={infoBox}>Prices refreshed from the current price lists. Save to keep them.</p>}

      <section className={`${card} grid grid-cols-1 gap-3 sm:grid-cols-2`}>
        <TextField name="ls-name" label="Line sheet name" value={v.name} onChange={set("name")} required error={errors.name} />
        <Select name="ls-business" label="Business" value={v.company_profile_id} onChange={setBusiness} options={businesses.map((b) => ({ value: b.id, label: b.display_name }))} error={errors.company_profile_id} />
        <Select name="ls-retailer" label="Retailer (optional)" value={v.retailer_id} onChange={setRetailer} options={[{ value: "", label: "None" }, ...retailers.map((r) => ({ value: r.id, label: r.name }))]} error={errors.retailer_id} />
        <TextField name="ls-prepared" label="Prepared for" value={v.prepared_for} onChange={set("prepared_for")} placeholder={retailer?.name ?? "A store or buyer"} hint={retailer ? `Leave blank to print "${retailer.name}".` : "Free text, or choose a retailer."} error={errors.prepared_for} />
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="text-sm font-semibold">Prices</h2>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="basis" checked={v.price_basis === "standard"} onChange={() => setBasis("standard")} /> Standard (MSRP is the product&apos;s sale price)</label>
          <label className="flex items-center gap-2"><input type="radio" name="basis" checked={v.price_basis === "retailer"} onChange={() => setBasis("retailer")} /> The retailer&apos;s price list</label>
        </div>
        {v.price_basis === "standard" ? (
          <div className="w-56">
            <TextField name="ls-percent" label="Wholesale as % of MSRP" value={v.standard_wholesale_percent} onChange={setPercent} inputMode="decimal" error={errors.standard_wholesale_percent} hint="Changing this recalculates every line. You can still edit a line's wholesale price." />
          </div>
        ) : (
          <p className={infoBox}>Prices come from {retailer ? `${retailer.name}'s` : "the chosen retailer's"} price list. Products without a price print &ldquo;{NO_PRICE_TEXT}&rdquo;.</p>
        )}
        <Checkbox name="ls-margin" label="Show the retailer's margin" checked={v.show_margin} onChange={(x) => setV((s) => ({ ...s, show_margin: x }))} />
      </section>

      <section className={`${card} space-y-3`}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Products ({lines.length}/{MAX_LINE_SHEET_LINES})</h2>
          <button type="button" className={btn} onClick={() => setPicker(true)} disabled={lines.length >= MAX_LINE_SHEET_LINES}>Add products</button>
        </div>
        {errors.lines && <p className={errorBox}>{errors.lines}</p>}
        {risky.length > 0 && <p className={warnBox} data-testid="risky-warning">Words to check in descriptions: {risky.map((w) => `“${w}”`).join(", ")}.</p>}
        {lines.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">No products yet.</p>
        ) : (
          <ol className="space-y-2" data-testid="ls-lines">
            {lines.map((l, i) => {
              const margin = marginPercent(l.wholesale_price, l.msrp);
              const photo = data.marketing.find((m) => m.photo_asset_id === l.photo_asset_id);
              return (
                <li key={l.key} className="rounded-md border border-zinc-200 p-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <span className="w-6 pt-6 text-xs font-semibold">{i + 1}.</span>
                    <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-4">
                      <div className="sm:col-span-2"><TextField name={`ln-${l.key}-name`} label="Name" value={l.name} onChange={(x) => setLine(l.key, { name: x })} error={errors[`lines.${i}.name`]} /></div>
                      <TextField name={`ln-${l.key}-size`} label="Size" value={l.size_text} onChange={(x) => setLine(l.key, { size_text: x })} placeholder="e.g. 4 oz" error={errors[`lines.${i}.size_text`]} />
                      <TextField name={`ln-${l.key}-case`} label="Case pack" value={l.case_pack_text} onChange={(x) => setLine(l.key, { case_pack_text: x })} placeholder="e.g. 12 per case" error={errors[`lines.${i}.case_pack_text`]} />
                      <div className="sm:col-span-4"><TextArea name={`ln-${l.key}-desc`} label={`Description (${l.description.length}/500)`} value={l.description} onChange={(x) => setLine(l.key, { description: x })} rows={2} error={errors[`lines.${i}.description`]} /></div>
                      <TextField name={`ln-${l.key}-w`} label="Wholesale" value={l.wholesale_price} onChange={(x) => setLine(l.key, { wholesale_price: x })} inputMode="decimal" placeholder={v.price_basis === "retailer" ? NO_PRICE_TEXT : ""} hint={l.wholesale_price ? formatUnitPrice(l.wholesale_price) : undefined} error={errors[`lines.${i}.wholesale_price`]} />
                      <TextField name={`ln-${l.key}-m`} label="MSRP" value={l.msrp} onChange={(x) => setLine(l.key, { msrp: x })} inputMode="decimal" placeholder={v.price_basis === "retailer" ? NO_PRICE_TEXT : ""} error={errors[`lines.${i}.msrp`]} />
                      <div className="text-xs sm:col-span-2">
                        <p>Margin: {margin ?? "—"}</p>
                        <p>Photo: {l.photo_asset_id ? photo?.photo_title ?? "Saved photo" : "None (a placeholder prints)"}{l.photo_asset_id && <button type="button" className="ml-2 underline" onClick={() => setLine(l.key, { photo_asset_id: null })}>Remove</button>}</p>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <button type="button" className={btn} onClick={() => move(i, -1)} aria-label={`Move ${l.name} up`} disabled={i === 0}>↑</button>
                      <button type="button" className={btn} onClick={() => move(i, 1)} aria-label={`Move ${l.name} down`} disabled={i === lines.length - 1}>↓</button>
                      <button type="button" className={btn} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove ${l.name}`}>✕</button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className={`${card} grid grid-cols-1 gap-3 sm:grid-cols-2`}>
        <h2 className="text-sm font-semibold sm:col-span-2">Terms and contact</h2>
        <TextField name="ls-min" label="Minimum order" value={v.minimum_order_text} onChange={set("minimum_order_text")} placeholder="e.g. $150 opening order" error={errors.minimum_order_text} />
        <TextField name="ls-lead" label="Lead time" value={v.lead_time_text} onChange={set("lead_time_text")} placeholder="e.g. Ships in 5 business days" error={errors.lead_time_text} />
        <TextField name="ls-terms" label="Payment terms" value={v.payment_terms_text} onChange={(x) => { setTermsTouched(true); set("payment_terms_text")(x); }} hint="Filled in from the retailer's terms for this business (or the business default)." error={errors.payment_terms_text} />
        <TextField name="ls-contact" label="Contact name" value={v.contact_name} onChange={set("contact_name")} error={errors.contact_name} />
        <TextField name="ls-email" label="Contact email" value={v.contact_email} onChange={set("contact_email")} error={errors.contact_email} />
        <TextField name="ls-phone" label="Contact phone" value={v.contact_phone} onChange={set("contact_phone")} error={errors.contact_phone} />
        <div className="sm:col-span-2"><TextArea name="ls-notes" label="Notes" value={v.notes} onChange={set("notes")} rows={3} error={errors.notes} /></div>
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btn} onClick={() => router.push(sheet ? `/fulfillment/retail/line-sheets/${sheet.id}` : "/fulfillment/retail?tab=line-sheets")}>Cancel</button>
        <button type="button" className={btn} onClick={doPreview} disabled={!!busy}>{busy === "preview" ? "Making preview…" : "Preview PDF"}</button>
        <button type="button" className={btn} onClick={() => save(false)} disabled={!!busy}>{busy === "save" ? "Saving…" : "Save"}</button>
        <button type="button" className={btnPrimary} onClick={() => save(true)} disabled={!!busy}>{busy === "download" ? "Saving…" : "Save & Download"}</button>
      </div>

      {picker && <ProductPicker products={products} taken={lines.map((l) => l.product_id).filter((x): x is string => !!x)} room={MAX_LINE_SHEET_LINES - lines.length} onClose={() => setPicker(false)} onAdd={(ids) => { addProducts(ids); setPicker(false); }} />}
      {preview && (
        <Dialog title="Preview" onClose={() => { URL.revokeObjectURL(preview); setPreview(null); }} wide>
          <div className="h-[75vh] overflow-hidden rounded-md border border-zinc-200 bg-zinc-100"><PdfViewer fileUrl={preview} /></div>
        </Dialog>
      )}
    </div>
  );
}

function ProductPicker({ products, taken, room, onClose, onAdd }: { products: RetailProduct[]; taken: string[]; room: number; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const list = products.filter((p) => !taken.includes(p.id) && (!q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <Dialog title="Add products" onClose={onClose} wide>
      <div className="space-y-2 text-black">
        <input aria-label="Search products" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className={input} />
        <p className="text-xs">{sel.length} selected · room for {room}</p>
        <ul className="max-h-80 space-y-0.5 overflow-y-auto rounded-md border border-zinc-200 p-1">
          {list.length === 0 && <li className="p-2 text-xs">No more products for this business.</li>}
          {list.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={sel.includes(p.id)}
                  disabled={!sel.includes(p.id) && sel.length >= room}
                  onChange={() => setSel((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))}
                />
                {p.name}
              </label>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={() => onAdd(sel)} disabled={sel.length === 0}>Add {sel.length || ""}</button>
        </div>
      </div>
    </Dialog>
  );
}
