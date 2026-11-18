"use client";

/**
 * Needs on library items (graphics, photos and videos an item still needs):
 * the editor's Needs section, the asset picker with suggestions, "Upload and
 * attach", and the Needs panel that groups needs across the library.
 */
import { useMemo, useState } from "react";
import { createLinkAssetApi, needsActionApi, needsGroupApi, uploadAsset, type GrowthApiError, type MarketingData } from "@/lib/growth/client";
import { mergeNeeds, type AssetNeed, type MergedNeed } from "@/lib/growth/adLibrary";
import { productKeyForName } from "@/lib/growth/playbookParse";
import { ASSET_CATEGORIES, CATEGORY_LABEL, categoryForProducts, suggestAssetsForNeed, validateAssetCategory } from "@/lib/growth/assetCategories";
import type { PremadeRow } from "@/lib/growth/libraryService";
import type { Asset } from "@/lib/growth/marketingService";
import { Checkbox, Chip, Dialog, ErrorSummary, Select, TextField, btn, btnPrimary, card, errorBox, infoBox, input, warnBox } from "./GrowthUi";
import { Drawer } from "./LibraryTabs";

const touch = "min-h-11";
const KIND_LABEL: Record<string, string> = { graphic: "Graphic", photo: "Photo", video: "Video", other: "Other" };
const KIND_TYPE: Record<string, string> = { graphic: "other", photo: "photo", video: "video", other: "other" };

/** Assets with their product names (from the product tags), for suggestions and labels. */
export function assetsWithProducts(data: MarketingData) {
  const name = new Map(data.products.map((p) => [p.id, p.name]));
  return data.assets.map((a) => ({
    ...a,
    product_ids: data.assetProductLinks.filter((l) => l.asset_id === a.id).map((l) => l.formulation_product_id),
    product_names: data.assetProductLinks.filter((l) => l.asset_id === a.id).map((l) => name.get(l.formulation_product_id) ?? ""),
    ingredient_ids: data.assetIngredientLinks.filter((l) => l.asset_id === a.id).map((l) => l.ingredient_tag_id),
  }));
}
export type AssetX = ReturnType<typeof assetsWithProducts>[number];

/** Formulation products matching an item's product keys (gum, toothpaste, …). */
export const productIdsForKeys = (data: MarketingData, keys: readonly string[]) =>
  data.products.filter((p) => {
    const k = productKeyForName(p.name);
    return !!k && keys.includes(k);
  }).map((p) => p.id);

export function NeedsSection({ data, item, reload }: { data: MarketingData; item: PremadeRow | null; reload: () => Promise<void> }) {
  const [picking, setPicking] = useState<AssetNeed | "general" | null>(null);
  const [uploading, setUploading] = useState<AssetNeed | null>(null);
  const [adding, setAdding] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const assetTitle = (id: string | null | undefined) => data.assets.find((a) => a.id === id)?.title ?? "an asset";
  const run = async (body: Record<string, unknown>) => {
    if (!item) return;
    setError(null);
    try {
      const r = await needsActionApi(item.id, body);
      setNotices(r.notices ?? []);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!item) {
    return (
      <section className={card}>
        <h3 className="text-sm font-semibold">Needs and attached assets</h3>
        <p className="text-xs">Save the item first to list what it needs and attach assets.</p>
      </section>
    );
  }
  const others = (key: string) => data.premades.filter((p) => !p.archived_at && p.id !== item.id && p.asset_needs.some((n) => n.key === key && n.status !== "ready"));
  return (
    <section className={`${card} space-y-3`} data-testid="needs-section">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Needs ({item.asset_needs.filter((n) => n.status !== "ready").length} open)</h3>
        <button type="button" className={btn} onClick={() => setAdding(true)}>Add need</button>
      </div>
      {error && <p className={errorBox} role="alert">{error}</p>}
      {notices.map((n) => <p key={n} className={warnBox}>{n}</p>)}
      {item.asset_needs.length === 0 && <p className="text-xs">No needs listed.</p>}
      <ul className="space-y-2">
        {item.asset_needs.map((n) => (
          <li key={n.key} className="rounded-md border border-zinc-200 p-2 text-sm" data-testid="need-row">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{n.label}</span> <Chip tone="zinc">{KIND_LABEL[n.kind]}</Chip>{" "}
                {n.status === "ready" ? <Chip tone="green">Ready: {assetTitle(n.asset_id)}</Chip> : <Chip tone="amber">Needed</Chip>}
                {n.note && <p className="text-xs">{n.note}</p>}
              </div>
              <div className="flex flex-wrap gap-1">
                {n.status !== "ready" ? (
                  <>
                    <button type="button" className={`${btn} ${touch}`} onClick={() => setPicking(n)}>Attach asset</button>
                    <button type="button" className={`${btn} ${touch}`} onClick={() => setUploading(n)}>Upload and attach</button>
                  </>
                ) : (
                  <button type="button" className={`${btn} ${touch}`} onClick={() => run({ op: "unlink", key: n.key })}>Unlink</button>
                )}
                <button type="button" className={`${btn} ${touch}`} onClick={() => run({ op: "remove", key: n.key })}>Remove need</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div>
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold">Attached assets ({item.asset_ids.length})</h4>
          <button type="button" className={btn} onClick={() => setPicking("general")}>Attach an asset</button>
        </div>
        <ul className="mt-1 space-y-1 text-xs" data-testid="attached-assets">
          {item.asset_ids.map((id) => (
            <li key={id} className="flex items-center justify-between gap-2">
              <span>{assetTitle(id)}</span>
              <button type="button" className={btn} onClick={() => run({ op: "detach_asset", asset_id: id })}>Remove</button>
            </li>
          ))}
        </ul>
      </div>
      {picking && (
        <AssetPicker
          data={data}
          need={picking === "general" ? null : picking}
          products={item.products_mentioned}
          alsoCount={picking === "general" ? 0 : others(picking.key).length}
          defaultAlso={picking !== "general" && picking.key.startsWith("cover:")}
          onClose={() => setPicking(null)}
          onPick={async (assetId, also) => {
            const need = picking;
            setPicking(null);
            if (need === "general") await run({ op: "attach_asset", asset_id: assetId });
            else await run({ op: "attach", key: need.key, asset_id: assetId, also_ids: also ? others(need.key).map((p) => p.id) : [] });
          }}
        />
      )}
      {uploading && (
        <UploadAttachDialog
          data={data}
          item={item}
          need={uploading}
          alsoCount={others(uploading.key).length}
          onClose={() => setUploading(null)}
          onDone={async (assetId, also) => {
            const need = uploading;
            setUploading(null);
            await run({ op: "attach", key: need.key, asset_id: assetId, also_ids: also ? others(need.key).map((p) => p.id) : [] });
          }}
        />
      )}
      {adding && <AddNeedDialog onClose={() => setAdding(false)} onAdd={async (body) => { setAdding(false); await run({ op: "add", ...body }); }} />}
    </section>
  );
}

function AddNeedDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (body: Record<string, unknown>) => void }) {
  const [v, setV] = useState({ label: "", kind: "photo", note: "" });
  return (
    <Dialog title="Add a need" onClose={onClose}>
      <div className="space-y-3 text-black">
        <TextField name="need-label" label="What's needed" value={v.label} onChange={(x) => setV({ ...v, label: x })} required />
        <Select name="need-kind" label="Kind" value={v.kind} onChange={(x) => setV({ ...v, kind: x })} options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />
        <TextField name="need-note" label="Note (optional)" value={v.note} onChange={(x) => setV({ ...v, note: x })} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={() => onAdd(v)} disabled={!v.label.trim()}>Add need</button>
        </div>
      </div>
    </Dialog>
  );
}

/** Picks an asset from the library, suggestions first. */
export function AssetPicker({
  data,
  need,
  products,
  alsoCount,
  defaultAlso,
  onClose,
  onPick,
}: {
  data: MarketingData;
  need: AssetNeed | null;
  products: readonly string[];
  alsoCount: number;
  defaultAlso: boolean;
  onClose: () => void;
  onPick: (assetId: string, also: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [product, setProduct] = useState("");
  const [also, setAlso] = useState(defaultAlso);
  const all = useMemo(() => assetsWithProducts(data), [data]);
  const ranked = suggestAssetsForNeed(need ?? { kind: "other" }, { products_mentioned: products }, all);
  const list = ranked.filter(
    (a) =>
      (!q || [a.title, a.context_label ?? "", a.notes ?? ""].some((s) => s.toLowerCase().includes(q.toLowerCase()))) &&
      (!category || (category === "uncategorized" ? !a.category : a.category === category)) &&
      (!product || a.product_ids.includes(product)),
  );
  return (
    <Dialog title={need ? `Attach an asset: ${need.label}` : "Attach an asset"} onClose={onClose} wide>
      <div className="space-y-2 text-black">
        <div className="flex flex-wrap gap-2">
          <input aria-label="Search assets" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className={`${input} w-48`} autoFocus />
          <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className={`${input} w-40`}>
            <option value="">All categories</option>
            {[...ASSET_CATEGORIES, "uncategorized" as const].map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
          <select aria-label="Product" value={product} onChange={(e) => setProduct(e.target.value)} className={`${input} w-40`}>
            <option value="">Any product</option>
            {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <p className="text-[11px]">Suggestions first: assets tagged with this item&apos;s products, then the matching type, then newest.</p>
        <ul className="max-h-80 space-y-1 overflow-y-auto" data-testid="asset-picker">
          {list.length === 0 && <li className="text-xs">No assets match. Use Upload and attach instead.</li>}
          {list.map((a) => (
            <li key={a.id}>
              <button type="button" className={`flex w-full items-center justify-between gap-2 rounded-md border border-zinc-200 p-2 text-left text-sm hover:bg-zinc-50 ${touch}`} onClick={() => onPick(a.id, also)}>
                <span>
                  <span className="font-medium">{a.title}</span>
                  <span className="ml-2 text-[11px]">{a.category ? CATEGORY_LABEL[a.category] : "Uncategorized"} · {a.asset_type}{a.product_names.length ? ` · ${a.product_names.join(", ")}` : ""}</span>
                </span>
                {a.status === "draft" && <Chip tone="amber">Draft</Chip>}
              </button>
            </li>
          ))}
        </ul>
        {need && alsoCount > 0 && <Checkbox name="also-apply" label={`Also apply to the ${alsoCount} other post${alsoCount === 1 ? "" : "s"} with the same need`} checked={also} onChange={setAlso} />}
      </div>
    </Dialog>
  );
}

/** Uploads a file (or saves a link) as a library asset, prefilled from the item, then attaches it. */
function UploadAttachDialog({ data, item, need, alsoCount, onClose, onDone }: { data: MarketingData; item: PremadeRow; need: AssetNeed; alsoCount: number; onClose: () => void; onDone: (assetId: string, also: boolean) => void }) {
  const productIds = productIdsForKeys(data, item.products_mentioned);
  const [mode, setMode] = useState<"upload" | "link">(need.kind === "video" ? "link" : "upload");
  const [file, setFile] = useState<File | null>(null);
  const [v, setV] = useState({
    title: need.label,
    category: categoryForProducts(productIds.length) ?? "",
    product_ids: productIds,
    asset_type: KIND_TYPE[need.kind] ?? "other",
    business: item.business,
    url: "",
    context_label: "",
  });
  const [also, setAlso] = useState(need.key.startsWith("cover:"));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const errs = validateAssetCategory({ category: v.category, productIds: v.product_ids, ingredientIds: [], contextLabel: v.context_label });
    setErrors(errs);
    if (Object.keys(errs).length) return setMessage("Some fields are missing or not valid.");
    setBusy(true);
    setMessage(null);
    try {
      const meta = { title: v.title, category: v.category, product_ids: v.product_ids, asset_type: v.asset_type, business: v.business, context_label: v.context_label, url: v.url };
      let asset: Asset;
      if (mode === "link") asset = (await createLinkAssetApi(meta)).asset;
      else {
        if (!file) throw new Error("Choose a file.");
        asset = (await uploadAsset(file, meta)).asset;
      }
      onDone(asset.id, also);
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Upload and attach: ${need.label}`} onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" checked={mode === "upload"} onChange={() => setMode("upload")} /> Upload a file</label>
          <label className="flex items-center gap-2"><input type="radio" checked={mode === "link"} onChange={() => setMode("link")} /> Paste a link</label>
        </div>
        {mode === "upload" ? (
          <input type="file" aria-label="File" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
        ) : (
          <TextField name="ua-url" label="Link" value={v.url} onChange={(x) => setV({ ...v, url: x })} placeholder="https://" hint="Videos are stored as links. Paste the share link from wherever the file lives." error={errors.url} />
        )}
        <TextField name="ua-title" label="Title" value={v.title} onChange={(x) => setV({ ...v, title: x })} required error={errors.title} />
        <Select name="ua-category" label="Category" value={v.category} onChange={(x) => setV({ ...v, category: x })} options={[{ value: "", label: "Choose…" }, ...ASSET_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]} error={errors.category} />
        <fieldset>
          <legend className="mb-1 text-xs font-medium">Products</legend>
          {errors.products && <p className={errorBox}>{errors.products}</p>}
          <div className="flex flex-wrap gap-3">
            {data.products.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={v.product_ids.includes(p.id)} onChange={() => setV({ ...v, product_ids: v.product_ids.includes(p.id) ? v.product_ids.filter((x) => x !== p.id) : [...v.product_ids, p.id] })} /> {p.name}
              </label>
            ))}
          </div>
        </fieldset>
        {v.category === "other" && <TextField name="ua-label" label="What is it?" value={v.context_label} onChange={(x) => setV({ ...v, context_label: x })} error={errors.context_label} />}
        {alsoCount > 0 && <Checkbox name="ua-also" label={`Also apply to the ${alsoCount} other post${alsoCount === 1 ? "" : "s"} with the same need`} checked={also} onChange={setAlso} />}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={save} disabled={busy}>{busy ? "Saving…" : "Save and attach"}</button>
        </div>
      </div>
    </Dialog>
  );
}

/** The library header's Needs panel: needs grouped by key across items. */
export function NeedsPanel({ data, reload, onClose }: { data: MarketingData; reload: () => Promise<void>; onClose: () => void }) {
  const live = data.premades.filter((p) => !p.archived_at);
  const groups = mergeNeeds(live);
  const [active, setActive] = useState<{ group: MergedNeed; op: "attach" | "unlink" } | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <Drawer title="Needs across the library" onClose={onClose}>
      {error && <p className={errorBox} role="alert">{error}</p>}
      {notices.map((n) => <p key={n} className={warnBox}>{n}</p>)}
      {groups.length === 0 ? (
        <p className={infoBox}>No library item lists any needs.</p>
      ) : (
        <table className="min-w-full text-left text-xs" data-testid="needs-panel">
          <thead className="bg-zinc-50"><tr>{["Need", "Kind", "Posts", "Status", ""].map((h) => <th key={h || "a"} className="px-2 py-2 font-semibold">{h || <span className="sr-only">Actions</span>}</th>)}</tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} className="border-t border-zinc-100">
                <td className="px-2 py-2"><span className="font-medium">{g.label}</span><div className="text-[11px]">{g.key}</div></td>
                <td className="px-2 py-2">{KIND_LABEL[g.kind]}</td>
                <td className="px-2 py-2">{g.count}</td>
                <td className="px-2 py-2">{g.status === "ready" ? <Chip tone="green">Ready</Chip> : g.status === "mixed" ? <Chip tone="amber">{g.readyCount} of {g.count} ready</Chip> : <Chip tone="amber">Needed</Chip>}</td>
                <td className="whitespace-nowrap px-2 py-2">
                  <div className="flex justify-end gap-1">
                    {g.status !== "ready" && <button type="button" className={`${btn} ${touch}`} onClick={() => setActive({ group: g, op: "attach" })}>Attach asset</button>}
                    {g.readyCount > 0 && <button type="button" className={`${btn} ${touch}`} onClick={() => setActive({ group: g, op: "unlink" })}>Unlink</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {active && (
        <GroupApply
          data={data}
          group={active.group}
          op={active.op}
          onClose={() => setActive(null)}
          onDone={async (body) => {
            setActive(null);
            setError(null);
            try {
              const r = await needsGroupApi(body);
              setNotices(r.notices);
              await reload();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      )}
    </Drawer>
  );
}

function GroupApply({ data, group, op, onClose, onDone }: { data: MarketingData; group: MergedNeed; op: "attach" | "unlink"; onClose: () => void; onDone: (body: Record<string, unknown>) => void }) {
  const items = data.premades.filter((p) => !p.archived_at && p.asset_needs.some((n) => n.key === group.key && (op === "attach" ? n.status !== "ready" : n.status === "ready")));
  const [ids, setIds] = useState(items.map((p) => p.id));
  const [picking, setPicking] = useState(false);
  const products = [...new Set(items.flatMap((p) => p.products_mentioned))];
  if (picking) return <AssetPicker data={data} need={items[0]?.asset_needs.find((n) => n.key === group.key) ?? null} products={products} alsoCount={0} defaultAlso={false} onClose={onClose} onPick={(assetId) => onDone({ op: "attach", key: group.key, asset_id: assetId, item_ids: ids })} />;
  return (
    <Dialog title={`${op === "attach" ? "Attach an asset to" : "Unlink"}: ${group.label}`} onClose={onClose} wide>
      <div className="space-y-2 text-black">
        <p className="text-xs">Choose the posts:</p>
        <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-zinc-200 p-1">
          {items.map((p) => (
            <li key={p.id}>
              <label className={`flex items-center gap-2 text-sm ${touch}`}>
                <input type="checkbox" checked={ids.includes(p.id)} onChange={() => setIds(ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id])} /> {p.display_name}
              </label>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} disabled={!ids.length} onClick={() => (op === "attach" ? setPicking(true) : onDone({ op: "unlink", key: group.key, item_ids: ids }))}>
            {op === "attach" ? "Choose the asset" : `Unlink from ${ids.length}`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
