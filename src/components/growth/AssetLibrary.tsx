"use client";

/**
 * Marketing Hub › Assets: the categorized asset library. Category chips with
 * counts (including Uncategorized), filters kept in the URL (as_*), add
 * several files or links at once with a shared category and tags, edit,
 * bulk actions, ingredient tags (the Admin-only "Add from Raw Materials"
 * copies names only), and the in-app viewer.
 */
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  assetBulkApi,
  createLinkAssetApi,
  rawMaterialNamesApi,
  saveIngredientTagApi,
  saveProfileApi,
  signedAssetUrlsApi,
  tagsFromRawMaterialsApi,
  updateAssetApi,
  uploadAsset,
  type GrowthApiError,
  type MarketingData,
} from "@/lib/growth/client";
import { ASSET_CATEGORIES, CATEGORY_LABEL, categoryCounts, validateAssetCategory, type AssetCategory } from "@/lib/growth/assetCategories";
import { Badge, Checkbox, Chip, ConfirmDialog, Dialog, ErrorSummary, Select, TextArea, TextField, btn, btnPrimary, card, errorBox, infoBox, input, warnBox } from "./GrowthUi";
import { assetsWithProducts, type AssetX } from "./LibraryNeeds";
import { useUrlParams } from "./useUrlParams";

const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), { ssr: false, loading: () => <p className="p-4 text-xs text-black">Loading…</p> });

type TabProps = { data: MarketingData; reload: () => Promise<void> };
const touch = "min-h-11";
export const ASSET_TYPES = [
  { value: "photo", label: "Photo" },
  { value: "video", label: "Video" },
  { value: "logo", label: "Logo" },
  { value: "template", label: "Template" },
  { value: "packaging", label: "Packaging" },
  { value: "document", label: "Document" },
  { value: "other", label: "Other" },
];
const BUSINESSES = [
  { value: "botaniqals", label: "BotanIQals" },
  { value: "minileaf", label: "MiniLeaf" },
  { value: "brand", label: "Brand (both)" },
];
const ALLOWED = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const MAX_BYTES = 25 * 1024 * 1024;
export const VIDEO_LINK_HINT = "Videos are stored as links. Paste the share link from wherever the file lives.";
const label = (list: ReadonlyArray<{ value: string; label: string }>, v: string | null) => list.find((x) => x.value === v)?.label ?? v ?? "—";
const isImage = (a: { source: string; mime_type: string | null }) => a.source === "upload" && (a.mime_type ?? "").startsWith("image/");

/** "Product · Gum Product A" style line: category and tags. */
export function tagLine(data: MarketingData, a: AssetX): string {
  const cat = a.category ? CATEGORY_LABEL[a.category as AssetCategory] : "Uncategorized";
  const tags = data.ingredientTags.filter((t) => a.ingredient_ids.includes(t.id)).map((t) => t.name);
  return [cat, a.is_full_lineup ? "Full lineup" : null, ...a.product_names.filter(Boolean), ...tags, a.context_label].filter(Boolean).join(" · ");
}

// --- Category fields (shared by add, edit and bulk) ---------------------------------------------
export type CategoryValue = { category: string; product_ids: string[]; ingredient_ids: string[]; is_full_lineup: boolean; context_label: string; shot_date: string };
export const emptyCategory = (over: Partial<CategoryValue> = {}): CategoryValue => ({ category: "", product_ids: [], ingredient_ids: [], is_full_lineup: false, context_label: "", shot_date: "", ...over });

export function CategoryFields({ data, value, onChange, errors, onNewTag }: { data: MarketingData; value: CategoryValue; onChange: (v: CategoryValue) => void; errors: Record<string, string>; onNewTag?: (id: string) => void }) {
  const [newTag, setNewTag] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const toggle = (k: "product_ids" | "ingredient_ids", id: string) =>
    onChange({ ...value, [k]: value[k].includes(id) ? value[k].filter((x) => x !== id) : [...value[k], id] });
  const c = value.category;
  const labelFor = c === "market" ? "Event name or location (optional)" : c === "retail" ? "Store name (optional)" : c === "other" ? "What is it? (required)" : "Label (optional)";
  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="mb-1 text-xs font-medium">Category</legend>
        <div className="flex flex-wrap gap-2">
          {ASSET_CATEGORIES.map((k) => (
            <label key={k} className={`flex items-center gap-2 rounded-md border px-3 text-sm ${touch} ${c === k ? "border-emerald-500 bg-emerald-50" : "border-zinc-300"}`}>
              <input type="radio" name="asset-category" checked={c === k} onChange={() => onChange({ ...value, category: k })} /> {CATEGORY_LABEL[k]}
            </label>
          ))}
        </div>
        {errors.category && <p className="mt-1 text-xs text-red-700">{errors.category}</p>}
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-xs font-medium">
          Products {c === "product" ? "(exactly one)" : c === "group_product" ? "(two or more, or Full lineup)" : "(optional)"}
        </legend>
        <ul className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
          {data.products.map((p) => (
            <li key={p.id}>
              <label className={`flex items-center gap-2 rounded-md border border-zinc-300 px-2 text-sm ${touch}`}>
                <input type="checkbox" checked={value.product_ids.includes(p.id)} onChange={() => toggle("product_ids", p.id)} /> {p.name}
              </label>
            </li>
          ))}
        </ul>
        {c === "group_product" && <Checkbox name="full-lineup" label="Full lineup" checked={value.is_full_lineup} onChange={(v) => onChange({ ...value, is_full_lineup: v })} />}
        {errors.products && <p className="mt-1 text-xs text-red-700">{errors.products}</p>}
      </fieldset>
      {(c === "ingredient" || value.ingredient_ids.length > 0) && (
        <fieldset>
          <legend className="mb-1 text-xs font-medium">Ingredient tags {c === "ingredient" ? "(at least one)" : ""}</legend>
          <ul className="flex flex-wrap gap-2">
            {data.ingredientTags.filter((t) => !t.archived_at || value.ingredient_ids.includes(t.id)).map((t) => (
              <li key={t.id}>
                <label className={`flex items-center gap-2 rounded-md border border-zinc-300 px-2 text-sm ${touch}`}>
                  <input type="checkbox" checked={value.ingredient_ids.includes(t.id)} onChange={() => toggle("ingredient_ids", t.id)} /> {t.name}
                </label>
              </li>
            ))}
          </ul>
          {onNewTag && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <input aria-label="New tag" placeholder="New tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} className={`${input} w-48`} />
              <button
                type="button"
                className={btn}
                onClick={async () => {
                  setTagError(null);
                  try {
                    const r = await saveIngredientTagApi(null, { name: newTag });
                    setNewTag("");
                    onNewTag(r.id);
                    onChange({ ...value, ingredient_ids: [...value.ingredient_ids, r.id] });
                  } catch (e) {
                    setTagError((e as Error).message);
                  }
                }}
              >
                New tag
              </button>
              {tagError && <span className="text-xs text-red-700">{tagError}</span>}
            </div>
          )}
          {errors.ingredients && <p className="mt-1 text-xs text-red-700">{errors.ingredients}</p>}
        </fieldset>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField name="ctx-label" label={labelFor} value={value.context_label} onChange={(x) => onChange({ ...value, context_label: x })} error={errors.context_label} />
        <TextField name="shot-date" label="Shot date (optional)" type="date" value={value.shot_date} onChange={(x) => onChange({ ...value, shot_date: x })} error={errors.shot_date} />
      </div>
    </div>
  );
}

const clientErrors = (v: CategoryValue, requireCategory = true) =>
  validateAssetCategory({ category: v.category, productIds: v.product_ids, ingredientIds: v.ingredient_ids, isFullLineup: v.is_full_lineup, contextLabel: v.context_label, requireCategory });

// --- The tab ----------------------------------------------------------------------------------------
export function AssetsTab({ data, reload }: TabProps) {
  const url = useUrlParams();
  const f = {
    cat: url.get("as_cat"),
    product: url.get("as_product"),
    tag: url.get("as_tag"),
    type: url.get("as_type"),
    business: url.get("as_business"),
    status: url.get("as_status", "active"),
    source: url.get("as_source"),
    q: url.get("as_q"),
  };
  const all = useMemo(() => assetsWithProducts(data), [data]);
  const visibleByStatus = all.filter((a) => (f.status === "active" ? a.status !== "archived" : f.status === "all" || a.status === f.status));
  const counts = categoryCounts(visibleByStatus);
  const rows = visibleByStatus.filter((a) => {
    if (f.cat === "uncategorized" ? !!a.category : f.cat && a.category !== f.cat) return false;
    if (f.product && !a.product_ids.includes(f.product)) return false;
    if (f.tag && !a.ingredient_ids.includes(f.tag)) return false;
    if (f.type && a.asset_type !== f.type) return false;
    if (f.business && a.business !== f.business) return false;
    if (f.source && a.source !== f.source) return false;
    const q = f.q.trim().toLowerCase();
    if (q && ![a.title, a.context_label ?? "", a.notes ?? ""].some((s) => s.toLowerCase().includes(q))) return false;
    return true;
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AssetX | null>(null);
  const [bulk, setBulk] = useState<"category" | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [viewing, setViewing] = useState<{ asset: AssetX; url: string } | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const imageIds = rows.filter(isImage).map((a) => a.id).slice(0, 100);
  const key = imageIds.join(",");
  useEffect(() => {
    if (!key) return;
    void signedAssetUrlsApi(key.split(",")).then((r) => setThumbs(r.urls)).catch(() => undefined);
  }, [key]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const open = async (a: AssetX, download: boolean) => {
    if (a.source === "link") {
      window.open(a.url!, "_blank", "noopener");
      return;
    }
    try {
      const r = await signedAssetUrlsApi([a.id], download);
      const u = r.urls[a.id];
      if (!u) throw new Error("Could not open the file.");
      if (download) {
        const link = document.createElement("a");
        link.href = u;
        link.click();
      } else if (a.mime_type === "application/pdf") setViewing({ asset: a, url: URL.createObjectURL(await (await fetch(u)).blob()) });
      else setViewing({ asset: a, url: u });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const chip = (k: string, text: string, n: number) => (
    <button
      key={k || "all"}
      type="button"
      onClick={() => url.set({ as_cat: k || null })}
      className={`rounded-full border px-3 text-xs font-medium ${touch} ${f.cat === k ? "border-emerald-600 bg-emerald-50" : "border-zinc-300 bg-white"}`}
      aria-pressed={f.cat === k}
      data-testid={`cat-chip-${k || "all"}`}
    >
      {text} ({n})
    </button>
  );
  return (
    <section className="space-y-3">
      {error && <p className={errorBox} role="alert">{error}</p>}
      {report && <p className={warnBox}>{report}</p>}
      <div className="flex flex-wrap gap-2" data-testid="category-chips">
        {chip("", "All", counts.all)}
        {ASSET_CATEGORIES.map((c) => chip(c, CATEGORY_LABEL[c], counts[c]))}
        {chip("uncategorized", "Uncategorized", counts.uncategorized)}
      </div>
      {counts.uncategorized > 0 && f.cat !== "uncategorized" && (
        <p className={infoBox}>
          {counts.uncategorized} asset{counts.uncategorized === 1 ? " has" : "s have"} no category yet.{" "}
          <button type="button" className="font-medium underline" onClick={() => url.set({ as_cat: "uncategorized" })}>Sort these</button>
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <input aria-label="Search assets" placeholder="Search title, label or notes" value={f.q} onChange={(e) => url.set({ as_q: e.target.value })} className={`${input} w-56`} />
        <select aria-label="Product" value={f.product} onChange={(e) => url.set({ as_product: e.target.value })} className={`${input} w-40`}><option value="">All products</option>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select aria-label="Ingredient tag" value={f.tag} onChange={(e) => url.set({ as_tag: e.target.value })} className={`${input} w-40`}><option value="">All ingredients</option>{data.ingredientTags.filter((t) => !t.archived_at).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select aria-label="Type" value={f.type} onChange={(e) => url.set({ as_type: e.target.value })} className={`${input} w-32`}><option value="">All types</option>{ASSET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
        <select aria-label="Business" value={f.business} onChange={(e) => url.set({ as_business: e.target.value })} className={`${input} w-36`}><option value="">All businesses</option>{BUSINESSES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</select>
        <select aria-label="Status" value={f.status} onChange={(e) => url.set({ as_status: e.target.value === "active" ? null : e.target.value })} className={`${input} w-36`}>
          <option value="active">Draft and ready</option><option value="draft">Draft</option><option value="ready">Ready</option><option value="archived">Archived</option><option value="all">All</option>
        </select>
        <select aria-label="Source" value={f.source} onChange={(e) => url.set({ as_source: e.target.value })} className={`${input} w-32`}><option value="">Any source</option><option value="upload">Upload</option><option value="link">Link</option></select>
        <button type="button" className={`${btn} ${touch}`} onClick={() => setTagsOpen(true)}>Manage ingredient tags</button>
        <button type="button" className={`${btnPrimary} ${touch} ml-auto`} onClick={() => setAdding(true)}>Add assets</button>
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-300 bg-zinc-50 p-2 text-sm" data-testid="asset-bulk">
          <span className="font-medium">{selected.length} selected</span>
          <button type="button" className={btn} onClick={() => setBulk("category")}>Set category and tags</button>
          <button type="button" className={btn} onClick={() => act(() => assetBulkApi({ ids: selected, action: "set_status", status: "ready" }))}>Mark ready</button>
          <button type="button" className={btn} onClick={() => act(() => assetBulkApi({ ids: selected, action: "set_status", status: "draft" }))}>Mark draft</button>
          <button type="button" className={btn} onClick={() => act(async () => { await assetBulkApi({ ids: selected, action: "archive" }); setSelected([]); })}>Archive</button>
          <button type="button" className={btn} onClick={() => setSelected([])}>Clear</button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">No assets match.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="assets-grid">
          {rows.map((a) => (
            <li key={a.id} className={`${card} space-y-2`} data-testid="asset-card">
              <div className="flex items-start gap-2">
                <input type="checkbox" aria-label={`Select ${a.title}`} checked={selected.includes(a.id)} onChange={() => setSelected((s) => (s.includes(a.id) ? s.filter((x) => x !== a.id) : [...s, a.id]))} className="mt-1 h-5 w-5" />
                <button type="button" onClick={() => open(a, false)} className="block w-full" aria-label={`Open ${a.title}`}>
                  {thumbs[a.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage
                    <img src={thumbs[a.id]} alt={a.title} className="h-36 w-full rounded object-cover" />
                  ) : (
                    <div className="flex h-36 w-full items-center justify-center rounded bg-zinc-100 text-xs">{a.source === "link" ? "Link" : a.mime_type === "application/pdf" ? "PDF" : "File"}</div>
                  )}
                </button>
              </div>
              <div>
                <p className="font-medium">{a.title}</p>
                <p className="text-xs" data-testid="asset-tag-line">{tagLine(data, a)}</p>
                <p className="text-xs">{label(ASSET_TYPES, a.asset_type)} · {label(BUSINESSES, a.business)}{a.shot_date ? ` · Shot ${a.shot_date}` : ""}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Chip tone={a.status === "ready" ? "green" : a.status === "archived" ? "zinc" : "amber"}>{a.status === "ready" ? "Ready" : a.status === "archived" ? "Archived" : "Draft"}</Chip>
                  {!a.category && <Badge tone="amber">Uncategorized</Badge>}
                  {a.project_url && <a href={a.project_url} target="_blank" rel="noopener noreferrer" className="text-xs underline">Editing project</a>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                <button type="button" className={btn} onClick={() => open(a, false)}>Open</button>
                {a.source === "upload" && <button type="button" className={btn} onClick={() => open(a, true)}>Download</button>}
                {a.status === "draft" && <button type="button" className={btn} onClick={() => act(() => updateAssetApi(a.id, { status: "ready" }))}>Mark ready</button>}
                {isImage(a) && a.product_ids.length === 1 && a.status !== "archived" && (
                  <button
                    type="button"
                    className={btn}
                    onClick={() => {
                      const pid = a.product_ids[0];
                      const profile = data.profiles.find((p) => p.formulation_product_id === pid);
                      void act(() => saveProfileApi(pid, { ...(profile ?? {}), primary_asset_id: a.id }));
                    }}
                  >
                    Set as primary photo
                  </button>
                )}
                <button type="button" className={btn} onClick={() => setEditing(a)}>Edit</button>
                <button type="button" className={btn} onClick={() => act(() => updateAssetApi(a.id, { status: a.status === "archived" ? "draft" : "archived" }))}>{a.status === "archived" ? "Restore" : "Archive"}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && <AddAssetsDialog data={data} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void reload(); }} reload={reload} />}
      {editing && <EditAssetDialog data={data} asset={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} reload={reload} />}
      {bulk && (
        <BulkCategoryDialog
          data={data}
          ids={selected}
          onClose={() => setBulk(null)}
          onDone={(msg) => {
            setBulk(null);
            setReport(msg);
            setSelected([]);
            void reload();
          }}
          reload={reload}
        />
      )}
      {tagsOpen && <IngredientTagsDialog data={data} reload={reload} onClose={() => setTagsOpen(false)} />}
      {viewing && (
        <Dialog title={viewing.asset.title} onClose={() => { if (viewing.asset.mime_type === "application/pdf") URL.revokeObjectURL(viewing.url); setViewing(null); }} wide>
          {viewing.asset.mime_type === "application/pdf" ? (
            <div className="h-[70vh] overflow-hidden rounded border border-zinc-200"><PdfViewer fileUrl={viewing.url} /></div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage
            <img src={viewing.url} alt={viewing.asset.title} className="max-h-[70vh] w-full object-contain" />
          )}
        </Dialog>
      )}
    </section>
  );
}

// --- Add several at once ------------------------------------------------------------------------------
type Pending = { key: string; file: File | null; url: string; title: string; asset_type: string; state: "waiting" | "saving" | "done" | "error"; error?: string };
let seq = 0;
const titleFromFile = (n: string) => n.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 200);

function AddAssetsDialog({ data, onClose, onDone, reload }: { data: MarketingData; onClose: () => void; onDone: () => void; reload: () => Promise<void> }) {
  const [cat, setCat] = useState<CategoryValue>(emptyCategory());
  const [business, setBusiness] = useState("botaniqals");
  const [projectUrl, setProjectUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<Pending[]>([]);
  const [link, setLink] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const addFiles = (list: FileList | null) => {
    const bad: string[] = [];
    const next: Pending[] = [];
    for (const f of Array.from(list ?? [])) {
      if (!ALLOWED.includes(f.type)) bad.push(`${f.name}: only PNG, JPG, WebP and PDF files can be uploaded.`);
      else if (f.size > MAX_BYTES) bad.push(`${f.name}: files can be at most 25 MB.`);
      else next.push({ key: `f${++seq}`, file: f, url: "", title: titleFromFile(f.name), asset_type: f.type === "application/pdf" ? "document" : "photo", state: "waiting" });
    }
    setFileError(bad.length ? bad.join(" ") : null);
    setItems((s) => [...s, ...next]);
  };
  const addLink = () => {
    const u = link.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) {
      setFileError("Paste a full link starting with http:// or https://.");
      return;
    }
    setFileError(null);
    setItems((s) => [...s, { key: `l${++seq}`, file: null, url: u, title: "", asset_type: "video", state: "waiting" }]);
    setLink("");
  };
  const setItem = (k: string, patch: Partial<Pending>) => setItems((s) => s.map((x) => (x.key === k ? { ...x, ...patch } : x)));
  const saveAll = async () => {
    const errs = clientErrors(cat);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    for (const it of items) {
      if (it.state === "done") continue;
      setItem(it.key, { state: "saving", error: undefined });
      const meta = {
        title: it.title || (it.file ? titleFromFile(it.file.name) : "Link"),
        asset_type: it.asset_type,
        business,
        project_url: projectUrl || null,
        notes: notes || null,
        category: cat.category,
        product_ids: cat.product_ids,
        ingredient_ids: cat.ingredient_ids,
        is_full_lineup: cat.is_full_lineup,
        context_label: cat.context_label || null,
        shot_date: cat.shot_date || null,
      };
      try {
        if (it.file) await uploadAsset(it.file, meta);
        else await createLinkAssetApi({ ...meta, url: it.url });
        setItem(it.key, { state: "done" });
      } catch (e) {
        setItem(it.key, { state: "error", error: (e as Error).message });
      }
    }
    setBusy(false);
  };
  const done = items.length > 0 && items.every((i) => i.state === "done");
  return (
    <Dialog title="Add assets" onClose={done ? onDone : onClose} wide>
      <div className="space-y-4 text-black">
        <div className={`${card} space-y-2`}>
          <p className="text-xs font-semibold">1. Files and links</p>
          <input type="file" multiple accept={ALLOWED.join(",")} aria-label="Files" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} className="text-sm" />
          <p className="text-[11px]">PNG, JPG, WebP or PDF, up to 25 MB each. Files are private and open with short-lived links.</p>
          <div className="flex flex-wrap items-end gap-2">
            <input aria-label="Paste a link" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} className={`${input} w-72`} />
            <button type="button" className={btn} onClick={addLink}>Add link</button>
          </div>
          <p className="text-[11px]">{VIDEO_LINK_HINT}</p>
          {fileError && <p className="text-xs text-red-700">{fileError}</p>}
        </div>
        <div className={`${card} space-y-2`}>
          <p className="text-xs font-semibold">2. Category and tags (applied to every item)</p>
          <CategoryFields data={data} value={cat} onChange={setCat} errors={errors} onNewTag={() => void reload()} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select name="aa-business" label="Business" value={business} onChange={setBusiness} options={BUSINESSES} />
            <TextField name="aa-project" label="Editing project link (optional)" value={projectUrl} onChange={setProjectUrl} placeholder="https://" />
          </div>
          <TextArea name="aa-notes" label="Notes" value={notes} onChange={setNotes} rows={2} />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-semibold">3. Check the titles ({items.length})</p>
          {items.length === 0 ? (
            <p className="text-xs">Nothing added yet.</p>
          ) : (
            <table className="min-w-full text-left text-xs" data-testid="add-assets-table">
              <thead className="bg-zinc-50"><tr>{["Item", "Title", "Type", "Status", ""].map((h) => <th key={h || "x"} className="px-2 py-1 font-semibold">{h}</th>)}</tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.key} className="border-t border-zinc-100 align-top">
                    <td className="max-w-40 truncate px-2 py-1">{it.file ? it.file.name : it.url}</td>
                    <td className="px-2 py-1"><input aria-label="Title" value={it.title} onChange={(e) => setItem(it.key, { title: e.target.value })} className={`${input} w-48`} disabled={it.state === "done"} /></td>
                    <td className="px-2 py-1">
                      <select aria-label="Type" value={it.asset_type} onChange={(e) => setItem(it.key, { asset_type: e.target.value })} className={`${input} w-28`} disabled={it.state === "done"}>
                        {ASSET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      {it.state === "waiting" && "Waiting"}
                      {it.state === "saving" && "Saving…"}
                      {it.state === "done" && <span className="text-emerald-800">Saved</span>}
                      {it.state === "error" && <span className="text-red-700">{it.error}</span>}
                    </td>
                    <td className="px-2 py-1">{it.state !== "done" && <button type="button" className={btn} onClick={() => setItems((s) => s.filter((x) => x.key !== it.key))} aria-label="Remove">✕</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {busy && <p className="text-xs">Saving {items.filter((i) => i.state === "done").length} of {items.length}…</p>}
        </div>
        <div className="flex justify-end gap-2">
          {done ? (
            <button type="button" className={btnPrimary} onClick={onDone}>Done</button>
          ) : (
            <>
              <button type="button" className={btn} onClick={items.some((i) => i.state === "done") ? onDone : onClose}>Close</button>
              <button type="button" className={btnPrimary} onClick={saveAll} disabled={busy || items.length === 0}>{busy ? "Saving…" : `Save ${items.filter((i) => i.state !== "done").length}`}</button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// --- Edit one asset -------------------------------------------------------------------------------------
function EditAssetDialog({ data, asset, onClose, onSaved, reload }: { data: MarketingData; asset: AssetX; onClose: () => void; onSaved: () => void; reload: () => Promise<void> }) {
  const [v, setV] = useState({ title: asset.title, asset_type: asset.asset_type, business: asset.business as string, status: asset.status as string, url: asset.url ?? "", project_url: asset.project_url ?? "", notes: asset.notes ?? "" });
  const [cat, setCat] = useState<CategoryValue>(
    emptyCategory({ category: asset.category ?? "", product_ids: asset.product_ids, ingredient_ids: asset.ingredient_ids, is_full_lineup: !!asset.is_full_lineup, context_label: asset.context_label ?? "", shot_date: asset.shot_date ?? "" }),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const save = async () => {
    const errs = clientErrors(cat, !!asset.category || !!cat.category);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    try {
      await updateAssetApi(asset.id, {
        ...v,
        category: cat.category || null,
        product_ids: cat.product_ids,
        ingredient_ids: cat.ingredient_ids,
        is_full_lineup: cat.is_full_lineup,
        context_label: cat.context_label || null,
        shot_date: cat.shot_date || null,
      });
      if (v.status !== asset.status) await updateAssetApi(asset.id, { status: v.status });
      onSaved();
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
    }
  };
  return (
    <Dialog title="Edit asset" onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        {!asset.category && <p className={infoBox}>This asset has no category yet. Choose one to sort it.</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField name="ea-title" label="Title" value={v.title} onChange={set("title")} required error={errors.title} />
          <Select name="ea-type" label="Type" value={v.asset_type} onChange={set("asset_type")} options={ASSET_TYPES} />
          <Select name="ea-business" label="Business" value={v.business} onChange={set("business")} options={BUSINESSES} />
          <Select name="ea-status" label="Status" value={v.status} onChange={set("status")} options={[{ value: "draft", label: "Draft" }, { value: "ready", label: "Ready" }, { value: "archived", label: "Archived" }]} />
        </div>
        {asset.source === "link" && <TextField name="ea-url" label="Link" value={v.url} onChange={set("url")} error={errors.url} hint={VIDEO_LINK_HINT} />}
        <CategoryFields data={data} value={cat} onChange={setCat} errors={errors} onNewTag={() => void reload()} />
        <TextField name="ea-project" label="Editing project link (optional)" value={v.project_url} onChange={set("project_url")} placeholder="https://" error={errors.project_url} />
        <TextArea name="ea-notes" label="Notes" value={v.notes} onChange={set("notes")} rows={2} error={errors.notes} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={save}>Save</button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Bulk: set category and tags ---------------------------------------------------------------------------
function BulkCategoryDialog({ data, ids, onClose, onDone, reload }: { data: MarketingData; ids: string[]; onClose: () => void; onDone: (msg: string) => void; reload: () => Promise<void> }) {
  const [cat, setCat] = useState<CategoryValue>(emptyCategory());
  const [replaceTags, setReplaceTags] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  return (
    <Dialog title={`Set category and tags (${ids.length} assets)`} onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <CategoryFields data={data} value={cat} onChange={setCat} errors={errors} onNewTag={() => void reload()} />
        <Checkbox name="bulk-replace" label="Replace each asset's product and ingredient tags with these" checked={replaceTags} onChange={setReplaceTags} />
        <p className="text-[11px]">Assets that don&apos;t meet the category&apos;s rule are left unchanged and listed.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={btnPrimary}
            onClick={async () => {
              if (!cat.category) {
                setErrors({ category: "Choose a category." });
                return;
              }
              try {
                const body: Record<string, unknown> = { ids, action: "set_category", category: cat.category, is_full_lineup: cat.is_full_lineup, context_label: cat.context_label || null };
                if (replaceTags) Object.assign(body, { product_ids: cat.product_ids, ingredient_ids: cat.ingredient_ids });
                const r = await assetBulkApi(body);
                onDone(r.failed.length ? `Updated ${r.updated}. Not changed: ${r.failed.map((f) => `${f.title} (${f.error})`).join("; ")}` : `Updated ${r.updated} asset${r.updated === 1 ? "" : "s"}.`);
              } catch (e) {
                setMessage((e as Error).message);
                setErrors((e as GrowthApiError).fields ?? {});
              }
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Ingredient tags ----------------------------------------------------------------------------------------
function IngredientTagsDialog({ data, reload, onClose }: { data: MarketingData; reload: () => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  return (
    <Dialog title="Ingredient tags" onClose={onClose} wide>
      <div className="space-y-3 text-black">
        {error && <p className={errorBox}>{error}</p>}
        <div className="flex flex-wrap items-end gap-2">
          <TextField name="tag-new" label="New tag" value={name} onChange={setName} />
          <button type="button" className={btnPrimary} onClick={async () => { if (await run(() => saveIngredientTagApi(null, { name }))) setName(""); }}>Add</button>
          {data.is_admin && <button type="button" className={btn} onClick={() => setRawOpen(true)}>Add from Raw Materials</button>}
        </div>
        <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200" data-testid="ingredient-tags">
          {data.ingredientTags.map((t) => (
            <li key={t.id} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm ${t.archived_at ? "opacity-60" : ""}`}>
              {editing?.id === t.id ? (
                <input aria-label="Tag name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={`${input} w-64`} />
              ) : (
                <span>{t.name} {t.archived_at && <Badge>Archived</Badge>}</span>
              )}
              <span className="flex gap-1">
                {editing?.id === t.id ? (
                  <>
                    <button type="button" className={btnPrimary} onClick={async () => { if (await run(() => saveIngredientTagApi(t.id, { name: editing.name }))) setEditing(null); }}>Save</button>
                    <button type="button" className={btn} onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    {!t.archived_at && <button type="button" className={btn} onClick={() => setEditing({ id: t.id, name: t.name })}>Rename</button>}
                    <button type="button" className={btn} onClick={() => run(() => saveIngredientTagApi(t.id, t.archived_at ? { restore: true } : { archive: true }))}>{t.archived_at ? "Restore" : "Archive"}</button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
        {rawOpen && data.is_admin && <RawMaterialsDialog data={data} onClose={() => setRawOpen(false)} onDone={async () => { setRawOpen(false); await reload(); }} />}
      </div>
    </Dialog>
  );
}

/** Admin only: names of raw materials (never quantities, costs or suppliers), copied into tags. */
function RawMaterialsDialog({ data, onClose, onDone }: { data: MarketingData; onClose: () => void; onDone: () => void }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const have = new Set(data.ingredientTags.filter((t) => !t.archived_at).map((t) => t.name.toLowerCase()));
  useEffect(() => {
    let cancelled = false;
    void rawMaterialNamesApi()
      .then((r) => !cancelled && setNames(r.names))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <ConfirmDialog
      title="Add tags from Raw Materials"
      confirmLabel={`Add ${sel.length || ""}`.trim()}
      busy={false}
      error={error}
      onClose={onClose}
      onConfirm={async () => {
        try {
          await tagsFromRawMaterialsApi(sel);
          onDone();
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <p className="text-xs">Names only. Tags are copies and don&apos;t stay linked to Raw Materials.</p>
      {!names && !error && <p className="text-xs">Loading…</p>}
      {names && (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border border-zinc-200 p-1" data-testid="raw-material-names">
          {names.map((n) => {
            const exists = have.has(n.toLowerCase());
            return (
              <li key={n}>
                <label className={`flex items-center gap-2 text-sm ${touch} ${exists ? "opacity-60" : ""}`}>
                  <input type="checkbox" disabled={exists} checked={sel.includes(n)} onChange={() => setSel((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n]))} /> {n}
                  {exists && <span className="text-xs">(already a tag)</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </ConfirmDialog>
  );
}
