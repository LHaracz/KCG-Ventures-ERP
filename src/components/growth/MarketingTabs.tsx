"use client";

/**
 * Marketing Hub tabs: Calendar (list and month views, post editor with the
 * Ready gate), Assets (uploads and links, signed previews), Claims (review
 * is Admin only), Products (profiles), Templates and Settings (Admin only).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import {
  archivePostApi,
  createClaimApi,
  createLinkAssetApi,
  reviewClaimApi,
  saveProfileApi,
  savePostApi,
  saveRiskyWordApi,
  saveTemplateApi,
  signedAssetUrlsApi,
  submitClaimApi,
  updateAssetApi,
  updateClaimApi,
  uploadAsset,
  type GrowthApiError,
  type MarketingData,
} from "@/lib/growth/client";
import { TEMPLATE_PLACEHOLDERS, applyTemplate, claimsReadyCheck, isReadyStatus, scanText } from "@/lib/growth/text";
import { addDays, todayNy } from "@/lib/growth/dates";
import type { Asset, Claim, Post, Template } from "@/lib/growth/marketingService";
import { Badge, Checkbox, Chip, ConfirmDialog, Dialog, ErrorSummary, Select, TextArea, TextField, btn, btnPrimary, card, errorBox, fmtDate, infoBox, input, warnBox } from "./GrowthUi";

const PdfViewer = dynamic(() => import("@/components/PdfViewer").then((m) => m.PdfViewer), { ssr: false, loading: () => <p className="p-4 text-xs text-black">Loading…</p> });

type TabProps = { data: MarketingData; reload: () => Promise<void> };

export const PLATFORMS = [
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "facebook", label: "Facebook" },
  { value: "youtube", label: "YouTube" },
  { value: "other", label: "Other" },
];
const POST_TYPES = [
  { value: "reel", label: "Reel" },
  { value: "story", label: "Story" },
  { value: "post", label: "Post" },
  { value: "ad", label: "Ad" },
  { value: "other", label: "Other" },
];
const POST_STATUSES = [
  { value: "idea", label: "Idea", tone: "zinc" },
  { value: "scripting", label: "Scripting", tone: "blue" },
  { value: "filming", label: "Filming", tone: "blue" },
  { value: "editing", label: "Editing", tone: "amber" },
  { value: "ready", label: "Ready", tone: "green" },
  { value: "scheduled", label: "Scheduled", tone: "green" },
  { value: "posted", label: "Posted", tone: "green" },
] as const;
const BUSINESSES = [
  { value: "botaniqals", label: "BotanIQals" },
  { value: "minileaf", label: "MiniLeaf" },
  { value: "brand", label: "Brand (both)" },
];
const ASSET_TYPES = [
  { value: "photo", label: "Photo" },
  { value: "video", label: "Video" },
  { value: "logo", label: "Logo" },
  { value: "template", label: "Template" },
  { value: "packaging", label: "Packaging" },
  { value: "document", label: "Document" },
  { value: "other", label: "Other" },
];
const CLAIM_TYPES = [
  { value: "ingredient_fact", label: "Ingredient fact" },
  { value: "benefit", label: "Benefit" },
  { value: "comparison", label: "Comparison" },
  { value: "certification", label: "Certification" },
  { value: "other", label: "Other" },
];
const CLAIM_STATUS: Record<string, { label: string; tone: "zinc" | "blue" | "green" | "red" | "amber" }> = {
  draft: { label: "Draft", tone: "zinc" },
  in_review: { label: "In review", tone: "blue" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  retired: { label: "Retired", tone: "zinc" },
};
export const CLAIMS_BANNER =
  "Claims must be reviewed against the rules that apply to each product (supplements and cosmetics are regulated differently). Approval here does not replace a regulatory review.";

const label = (list: ReadonlyArray<{ value: string; label: string }>, v: string | null) => list.find((x) => x.value === v)?.label ?? v ?? "—";
const statusChip = (s: string) => {
  const x = POST_STATUSES.find((p) => p.value === s);
  return <Chip tone={x?.tone ?? "zinc"}>{x?.label ?? s}</Chip>;
};

export function CopyButton({ text, labelText = "Copy" }: { text: string; labelText?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={btn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "Copied" : labelText}
    </button>
  );
}

export function RiskyWarnings({ texts, words }: { texts: Array<string | null | undefined>; words: string[] }) {
  const found = [...new Set(texts.flatMap((t) => scanText(t, words).map((m) => m.phrase)))];
  if (found.length === 0) return null;
  return (
    <p className={warnBox} data-testid="risky-warning">
      Words to check: {found.map((w) => `"${w}"`).join(", ")}. These may need review (for example disease or cure claims).
    </p>
  );
}

const activeWords = (data: MarketingData) => data.riskyWords.filter((w) => !w.archived_at).map((w) => w.phrase);

// --- Products --------------------------------------------------------------------------------
export function ProductsTab({ data, reload }: TabProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const images = data.assets.filter((a) => a.source === "upload" && (a.mime_type ?? "").startsWith("image/") && a.status !== "archived");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const primaryIds = data.profiles.map((p) => p.primary_asset_id).filter((x): x is string => !!x);
  const key = primaryIds.join(",");
  useEffect(() => {
    if (!key) return;
    void signedAssetUrlsApi(key.split(",")).then((r) => setThumbs(r.urls)).catch(() => undefined);
  }, [key]);
  if (data.products.length === 0) return <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">No BotanIQals products in Formulation yet.</p>;
  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="product-cards">
      <p className={`${infoBox} lg:col-span-2`}>BotanIQals products from Formulation, including ones still in development. MiniLeaf has no product profiles. Ingredients here are typed as they appear on the label; nothing is read from formulas.</p>
      {data.products.map((p) => {
        const profile = data.profiles.find((x) => x.formulation_product_id === p.id) ?? null;
        const approved = data.claims.filter((c) => c.status === "approved" && c.formulation_product_id === p.id);
        const words = activeWords(data);
        return (
          <div key={p.id} className={`${card} space-y-2`} data-testid="product-card">
            <div className="flex items-start justify-between gap-2">
              <div className="flex gap-3">
                {profile?.primary_asset_id && thumbs[profile.primary_asset_id] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage
                  <img src={thumbs[profile.primary_asset_id]} alt={`${p.name} primary photo`} className="h-16 w-16 rounded object-cover" />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded bg-zinc-100 text-[10px]">No photo</div>
                )}
                <div>
                  <h2 className="text-base font-semibold">{p.name}</h2>
                  {p.in_development && <Badge tone="amber">In development</Badge>}
                  <p className="text-sm">{profile?.tagline ?? "No tagline yet"}</p>
                </div>
              </div>
              <button type="button" className={btn} onClick={() => setEditing(p.id)}>Edit profile</button>
            </div>
            {profile?.short_description && <p className="text-sm">{profile.short_description}</p>}
            <RiskyWarnings texts={[profile?.tagline, profile?.short_description, profile?.long_description, profile?.key_points, profile?.hashtags]} words={words} />
            <div>
              <p className="text-xs font-semibold">Approved claims</p>
              {approved.length === 0 ? (
                <p className="text-xs">None yet.</p>
              ) : (
                <ul className="space-y-1">
                  {approved.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                      <span>{c.claim_text}</span>
                      <CopyButton text={c.claim_text} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {editing === p.id && <ProfileDialog productName={p.name} productId={p.id} profile={profile} images={images} words={words} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
          </div>
        );
      })}
    </section>
  );
}

function ProfileDialog({
  productName,
  productId,
  profile,
  images,
  words,
  onClose,
  onSaved,
}: {
  productName: string;
  productId: string;
  profile: MarketingData["profiles"][number] | null;
  images: Asset[];
  words: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [v, setV] = useState({
    tagline: profile?.tagline ?? "",
    short_description: profile?.short_description ?? "",
    long_description: profile?.long_description ?? "",
    label_ingredients: profile?.label_ingredients ?? "",
    key_points: profile?.key_points ?? "",
    hashtags: profile?.hashtags ?? "",
    do_not_say: profile?.do_not_say ?? "",
    primary_asset_id: profile?.primary_asset_id ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const save = async () => {
    try {
      await saveProfileApi(productId, { ...v, primary_asset_id: v.primary_asset_id || null });
      onSaved();
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
    }
  };
  return (
    <Dialog title={`Profile: ${productName}`} onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <TextField name="p-tagline" label={`Tagline (${v.tagline.length}/150)`} value={v.tagline} onChange={set("tagline")} error={errors.tagline} />
        <TextArea name="p-short" label={`Short description (${v.short_description.length}/300)`} value={v.short_description} onChange={set("short_description")} rows={2} error={errors.short_description} />
        <TextArea name="p-long" label="Long description" value={v.long_description} onChange={set("long_description")} rows={4} error={errors.long_description} />
        <TextArea name="p-ingredients" label="Ingredients as they appear on the label" value={v.label_ingredients} onChange={set("label_ingredients")} rows={3} error={errors.label_ingredients} hint="Typed by hand from the label. Never read from the formula." />
        <TextArea name="p-points" label="Key points" value={v.key_points} onChange={set("key_points")} rows={3} error={errors.key_points} />
        <TextField name="p-hashtags" label="Hashtags" value={v.hashtags} onChange={set("hashtags")} error={errors.hashtags} />
        <TextArea name="p-dont" label="Do not say" value={v.do_not_say} onChange={set("do_not_say")} rows={2} error={errors.do_not_say} />
        <Select
          name="p-photo"
          label="Primary photo"
          value={v.primary_asset_id}
          onChange={set("primary_asset_id")}
          options={[{ value: "", label: "None" }, ...images.map((a) => ({ value: a.id, label: a.title }))]}
          error={errors.primary_asset_id}
          hint="Uploaded images from the Assets tab."
        />
        <RiskyWarnings texts={[v.tagline, v.short_description, v.long_description, v.key_points, v.hashtags]} words={words} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={save}>Save profile</button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Claims ----------------------------------------------------------------------------------
export function ClaimsTab({ data, reload }: TabProps) {
  const today = todayNy();
  const [status, setStatus] = useState("");
  const [product, setProduct] = useState("");
  const [editing, setEditing] = useState<Claim | "new" | null>(null);
  const [reviewing, setReviewing] = useState<{ claim: Claim; action: "approve" | "reject" | "retire" } | null>(null);
  const [history, setHistory] = useState<Claim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const productName = (id: string | null) => (id ? data.products.find((p) => p.id === id)?.name ?? "Unknown product" : "Brand-wide");
  const rows = data.claims.filter((c) => (!status || c.status === status) && (!product || (product === "brand" ? !c.formulation_product_id : c.formulation_product_id === product)));
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="space-y-3">
      <p className={warnBox} data-testid="claims-banner">{CLAIMS_BANNER}</p>
      {error && <p className={errorBox} role="alert">{error}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className={`${input} w-40`}>
          <option value="">All statuses</option>
          {Object.entries(CLAIM_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select aria-label="Product" value={product} onChange={(e) => setProduct(e.target.value)} className={`${input} w-48`}>
          <option value="">All products</option>
          <option value="brand">Brand-wide</option>
          {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button type="button" className={`${btnPrimary} ml-auto`} onClick={() => setEditing("new")}>New claim</button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">No claims match.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full text-left text-xs" data-testid="claims-table">
            <thead className="bg-zinc-50">
              <tr>{["Claim", "Product", "Type", "Status", "Reviewed by", "Review again on", ""].map((h) => <th key={h || "a"} className="px-3 py-2 font-semibold">{h || <span className="sr-only">Actions</span>}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const due = c.status === "approved" && c.review_again_on && c.review_again_on <= today;
                return (
                  <tr key={c.id} className={`border-t border-zinc-100 align-top ${due ? "bg-amber-50" : ""}`} data-testid="claim-row">
                    <td className="max-w-md px-3 py-2">
                      {c.claim_text}
                      {c.review_note && <p className="mt-1 text-[11px]">Review note: {c.review_note}</p>}
                    </td>
                    <td className="px-3 py-2">{productName(c.formulation_product_id)}</td>
                    <td className="px-3 py-2">{label(CLAIM_TYPES, c.claim_type)}</td>
                    <td className="px-3 py-2"><Chip tone={CLAIM_STATUS[c.status].tone}>{CLAIM_STATUS[c.status].label}</Chip></td>
                    <td className="px-3 py-2">{c.reviewed_by_name ?? "—"}</td>
                    <td className="px-3 py-2">{fmtDate(c.review_again_on)}{due && <div><Badge tone="amber">Review due</Badge></div>}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1">
                        {c.status === "approved" && <CopyButton text={c.claim_text} />}
                        {c.status !== "retired" && <button type="button" className={btn} onClick={() => setEditing(c)}>Edit</button>}
                        {(c.status === "draft" || c.status === "rejected") && <button type="button" className={btn} onClick={() => act(() => submitClaimApi(c.id))}>Submit for review</button>}
                        {data.is_admin && c.status !== "approved" && c.status !== "retired" && <button type="button" className={btn} onClick={() => setReviewing({ claim: c, action: "approve" })}>Approve</button>}
                        {data.is_admin && (c.status === "in_review" || c.status === "approved") && <button type="button" className={btn} onClick={() => setReviewing({ claim: c, action: "reject" })}>Reject</button>}
                        {data.is_admin && c.status !== "retired" && <button type="button" className={btn} onClick={() => setReviewing({ claim: c, action: "retire" })}>Retire</button>}
                        <button type="button" className={btn} onClick={() => setHistory(c)}>History</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ClaimDialog data={data} claim={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
      {reviewing && <ReviewDialog r={reviewing} onClose={() => setReviewing(null)} onDone={() => { setReviewing(null); void reload(); }} />}
      {history && (
        <Dialog title="Claim history" onClose={() => setHistory(null)} wide>
          <ul className="space-y-1 text-xs text-black" data-testid="claim-history">
            {data.claimEvents.filter((e) => e.claim_id === history.id).map((e) => (
              <li key={e.id}>
                <span className="font-medium">{new Date(e.created_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}</span> · {e.actor_name ?? "Unknown"} · {e.event.replace(/_/g, " ")}
                {e.note ? ` (${e.note})` : ""}
                {e.claim_text_snapshot && <div className="pl-3">“{e.claim_text_snapshot}”</div>}
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </section>
  );
}

function ClaimDialog({ data, claim, onClose, onSaved }: { data: MarketingData; claim: Claim | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({
    claim_text: claim?.claim_text ?? "",
    formulation_product_id: claim?.formulation_product_id ?? "",
    claim_type: claim?.claim_type ?? "benefit",
    evidence_note: claim?.evidence_note ?? "",
    evidence_url: claim?.evidence_url ?? "",
    review_again_on: claim?.review_again_on ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const textChanged = !!claim && claim.status === "approved" && v.claim_text.trim() !== claim.claim_text;
  const save = async (submit: boolean) => {
    try {
      const body = { ...v, formulation_product_id: v.formulation_product_id || null };
      if (claim) {
        await updateClaimApi(claim.id, body);
        if (submit) await submitClaimApi(claim.id);
      } else await createClaimApi({ ...body, submit });
      onSaved();
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
    }
  };
  return (
    <Dialog title={claim ? "Edit claim" : "New claim"} onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <TextArea name="c-text" label={`Claim (${v.claim_text.length}/500)`} value={v.claim_text} onChange={set("claim_text")} rows={3} error={errors.claim_text} />
        {textChanged && <p className={warnBox} data-testid="reset-warning">This will reset it to draft and it must be approved again.</p>}
        <RiskyWarnings texts={[v.claim_text]} words={activeWords(data)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select name="c-product" label="Product" value={v.formulation_product_id} onChange={set("formulation_product_id")} options={[{ value: "", label: "Brand-wide" }, ...data.products.map((p) => ({ value: p.id, label: p.name }))]} error={errors.formulation_product_id} />
          <Select name="c-type" label="Type" value={v.claim_type} onChange={set("claim_type")} options={CLAIM_TYPES} />
          <TextField name="c-url" label="Evidence link" value={v.evidence_url} onChange={set("evidence_url")} placeholder="https://" error={errors.evidence_url} />
          <TextField name="c-again" label="Review again on" type="date" value={v.review_again_on} onChange={set("review_again_on")} error={errors.review_again_on} />
        </div>
        <TextArea name="c-evidence" label="Evidence note" value={v.evidence_note} onChange={set("evidence_note")} rows={3} error={errors.evidence_note} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btn} onClick={() => save(false)}>Save as draft</button>
          <button type="button" className={btnPrimary} onClick={() => save(true)}>Save and submit for review</button>
        </div>
      </div>
    </Dialog>
  );
}

function ReviewDialog({ r, onClose, onDone }: { r: { claim: Claim; action: "approve" | "reject" | "retire" }; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [again, setAgain] = useState(r.claim.review_again_on ?? addDays(todayNy(), 365));
  const [error, setError] = useState<string | null>(null);
  const titles = { approve: "Approve claim", reject: "Reject claim", retire: "Retire claim" };
  return (
    <ConfirmDialog
      title={titles[r.action]}
      confirmLabel={titles[r.action].split(" ")[0]}
      busy={false}
      error={error}
      onConfirm={async () => {
        try {
          await reviewClaimApi(r.claim.id, { action: r.action, note, review_again_on: r.action === "approve" ? again : undefined });
          onDone();
        } catch (e) {
          setError((e as Error).message);
        }
      }}
      onClose={onClose}
    >
      <p className="text-sm">“{r.claim.claim_text}”</p>
      <TextArea name="review-note" label={r.action === "reject" ? "Note (required)" : "Note"} value={note} onChange={setNote} rows={2} />
      {r.action === "approve" && <TextField name="review-again" label="Review again on" type="date" value={again} onChange={setAgain} />}
      <p className="text-[11px]">{CLAIMS_BANNER}</p>
    </ConfirmDialog>
  );
}

// --- Assets ------------------------------------------------------------------------------------
export function AssetsTab({ data, reload }: TabProps) {
  const [type, setType] = useState("");
  const [product, setProduct] = useState("");
  const [business, setBusiness] = useState("");
  const [status, setStatus] = useState("active");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [viewing, setViewing] = useState<{ asset: Asset; url: string } | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const rows = data.assets.filter(
    (a) =>
      (!type || a.asset_type === type) &&
      (!product || a.formulation_product_id === product) &&
      (!business || a.business === business) &&
      (status === "active" ? a.status !== "archived" : !status || a.status === status) &&
      (!q.trim() || a.title.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const imageIds = rows.filter((a) => a.source === "upload" && (a.mime_type ?? "").startsWith("image/")).map((a) => a.id).slice(0, 100);
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
  const open = async (a: Asset, download: boolean) => {
    if (a.source === "link") {
      window.open(a.url!, "_blank", "noopener");
      return;
    }
    try {
      const r = await signedAssetUrlsApi([a.id], download);
      const url = r.urls[a.id];
      if (!url) throw new Error("Could not open the file.");
      if (download) {
        const link = document.createElement("a");
        link.href = url;
        link.click();
      } else if (a.mime_type === "application/pdf") {
        const blob = await (await fetch(url)).blob();
        setViewing({ asset: a, url: URL.createObjectURL(blob) });
      } else setViewing({ asset: a, url });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const productName = (id: string | null) => (id ? data.products.find((p) => p.id === id)?.name ?? "" : "");
  return (
    <section className="space-y-3">
      {error && <p className={errorBox} role="alert">{error}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <input aria-label="Search assets" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className={`${input} w-48`} />
        <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className={`${input} w-32`}><option value="">All types</option>{ASSET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
        <select aria-label="Product" value={product} onChange={(e) => setProduct(e.target.value)} className={`${input} w-40`}><option value="">All products</option>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select aria-label="Business" value={business} onChange={(e) => setBusiness(e.target.value)} className={`${input} w-36`}><option value="">All businesses</option>{BUSINESSES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className={`${input} w-36`}>
          <option value="active">Draft and ready</option><option value="draft">Draft</option><option value="ready">Ready</option><option value="archived">Archived</option><option value="">All</option>
        </select>
        <button type="button" className={`${btnPrimary} ml-auto`} onClick={() => setAdding(true)}>Add asset</button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">No assets match.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="assets-grid">
          {rows.map((a) => (
            <li key={a.id} className={`${card} space-y-2`} data-testid="asset-card">
              <button type="button" onClick={() => open(a, false)} className="block w-full" aria-label={`Open ${a.title}`}>
                {thumbs[a.id] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage
                  <img src={thumbs[a.id]} alt={a.title} className="h-36 w-full rounded object-cover" />
                ) : (
                  <div className="flex h-36 w-full items-center justify-center rounded bg-zinc-100 text-xs">{a.source === "link" ? "Link" : a.mime_type === "application/pdf" ? "PDF" : "File"}</div>
                )}
              </button>
              <div>
                <p className="font-medium">{a.title}</p>
                <p className="text-xs">{label(ASSET_TYPES, a.asset_type)} · {label(BUSINESSES, a.business)}{productName(a.formulation_product_id) ? ` · ${productName(a.formulation_product_id)}` : ""}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Chip tone={a.status === "ready" ? "green" : a.status === "archived" ? "zinc" : "amber"}>{a.status === "ready" ? "Ready" : a.status === "archived" ? "Archived" : "Draft"}</Chip>
                  {a.project_url && <a href={a.project_url} target="_blank" rel="noopener noreferrer" className="text-xs underline">Editing project</a>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                <button type="button" className={btn} onClick={() => open(a, false)}>Open</button>
                {a.source === "upload" && <button type="button" className={btn} onClick={() => open(a, true)}>Download</button>}
                {a.status === "draft" && <button type="button" className={btn} onClick={() => act(() => updateAssetApi(a.id, { status: "ready" }))}>Mark ready</button>}
                {a.source === "upload" && (a.mime_type ?? "").startsWith("image/") && a.formulation_product_id && a.status !== "archived" && (
                  <button
                    type="button"
                    className={btn}
                    onClick={() => {
                      const profile = data.profiles.find((p) => p.formulation_product_id === a.formulation_product_id);
                      void act(() => saveProfileApi(a.formulation_product_id!, { ...(profile ?? {}), primary_asset_id: a.id }));
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
      {(adding || editing) && <AssetDialog data={data} asset={editing} onClose={() => { setAdding(false); setEditing(null); }} onSaved={() => { setAdding(false); setEditing(null); void reload(); }} />}
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

function AssetDialog({ data, asset, onClose, onSaved }: { data: MarketingData; asset: Asset | null; onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<"upload" | "link">(asset?.source ?? "upload");
  const [file, setFile] = useState<File | null>(null);
  const [v, setV] = useState({
    title: asset?.title ?? "",
    business: asset?.business ?? "botaniqals",
    formulation_product_id: asset?.formulation_product_id ?? "",
    asset_type: asset?.asset_type ?? "photo",
    url: asset?.url ?? "",
    project_url: asset?.project_url ?? "",
    notes: asset?.notes ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const fileRef = useRef<HTMLInputElement>(null);
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const meta = { ...v, formulation_product_id: v.formulation_product_id || null };
      if (asset) await updateAssetApi(asset.id, meta);
      else if (mode === "link") await createLinkAssetApi(meta);
      else {
        if (!file) throw new Error("Choose a file.");
        if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(file.type)) throw new Error("Only PNG, JPG, WebP and PDF files can be uploaded. Videos are stored as links.");
        if (file.size > 25 * 1024 * 1024) throw new Error("Files can be at most 25 MB.");
        await uploadAsset(file, { ...meta, title: meta.title || file.name.replace(/\.[^.]+$/, "") });
      }
      onSaved();
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
      setBusy(false);
    }
  };
  return (
    <Dialog title={asset ? "Edit asset" : "Add asset"} onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        {!asset && (
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" checked={mode === "upload"} onChange={() => setMode("upload")} /> Upload a file</label>
            <label className="flex items-center gap-2"><input type="radio" checked={mode === "link"} onChange={() => setMode("link")} /> Paste a link</label>
          </div>
        )}
        {!asset && mode === "upload" && (
          <div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" aria-label="File" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            <p className="mt-1 text-[11px]">PNG, JPG, WebP or PDF, up to 25 MB. Files are private and open with short-lived links.</p>
          </div>
        )}
        {(asset?.source === "link" || (!asset && mode === "link")) && (
          <TextField name="a-url" label="Link" value={v.url} onChange={set("url")} placeholder="https://" error={errors.url} hint="Videos are stored as links. Paste the share link from wherever the file lives." />
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField name="a-title" label="Title" value={v.title} onChange={set("title")} required={!!asset || mode === "link"} error={errors.title} />
          <Select name="a-type" label="Type" value={v.asset_type} onChange={set("asset_type")} options={ASSET_TYPES} />
          <Select name="a-business" label="Business" value={v.business} onChange={set("business")} options={BUSINESSES} />
          <Select name="a-product" label="Product" value={v.formulation_product_id} onChange={set("formulation_product_id")} options={[{ value: "", label: "None" }, ...data.products.map((p) => ({ value: p.id, label: p.name }))]} error={errors.formulation_product_id} />
        </div>
        <TextField name="a-project" label="Editing project link (optional)" value={v.project_url} onChange={set("project_url")} placeholder="https://" error={errors.project_url} />
        <TextArea name="a-notes" label="Notes" value={v.notes} onChange={set("notes")} rows={2} error={errors.notes} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Calendar ----------------------------------------------------------------------------------
export function CalendarTab({ data, reload }: TabProps) {
  const today = todayNy();
  const [view, setView] = useState<"list" | "month">("list");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [f, setF] = useState({ platform: "", status: "", owner: "", product: "", business: "", mine: false });
  const [editing, setEditing] = useState<Post | "new" | null>(null);
  const [draftFrom, setDraftFrom] = useState<Partial<Post> | null>(null);
  const me = data.me;
  const rows = data.posts.filter(
    (p) =>
      !p.archived_at &&
      (!f.platform || p.platform === f.platform) &&
      (!f.status || p.status === f.status) &&
      (!f.owner || p.owner_account_id === f.owner) &&
      (!f.product || p.formulation_product_id === f.product) &&
      (!f.business || p.business === f.business) &&
      (!f.mine || (me && p.owner_account_id === me)),
  );
  const sorted = [...rows].sort((a, b) => (a.scheduled_date ?? "9999").localeCompare(b.scheduled_date ?? "9999") || (a.scheduled_time ?? "").localeCompare(b.scheduled_time ?? ""));
  const owner = (id: string | null) => data.employees.find((e) => e.id === id)?.name ?? "—";
  const duplicate = (p: Post) => {
    setDraftFrom({ ...p, id: undefined, title: `${p.title} (copy)`, status: "idea", posted_url: null, posted_at: null, risky_words_checked: false });
    setEditing("new");
  };
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex rounded-md border border-zinc-300" role="group" aria-label="View">
          <button type="button" className={`px-3 py-1.5 text-xs ${view === "list" ? "bg-zinc-100 font-semibold" : ""}`} aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
          <button type="button" className={`px-3 py-1.5 text-xs ${view === "month" ? "bg-zinc-100 font-semibold" : ""}`} aria-pressed={view === "month"} onClick={() => setView("month")}>Month</button>
        </div>
        <select aria-label="Platform" value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })} className={`${input} w-32`}><option value="">All platforms</option>{PLATFORMS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
        <select aria-label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className={`${input} w-32`}><option value="">All statuses</option>{POST_STATUSES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
        <select aria-label="Owner" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} className={`${input} w-36`}><option value="">Anyone</option>{data.employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <select aria-label="Product" value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })} className={`${input} w-36`}><option value="">All products</option>{data.products.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <select aria-label="Business" value={f.business} onChange={(e) => setF({ ...f, business: e.target.value })} className={`${input} w-32`}><option value="">All businesses</option>{BUSINESSES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
        <Checkbox name="mine" label="Mine" checked={f.mine} onChange={(v) => setF({ ...f, mine: v })} />
        <button type="button" className={`${btnPrimary} ml-auto`} onClick={() => { setDraftFrom(null); setEditing("new"); }}>New post</button>
      </div>
      {view === "list" ? (
        sorted.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">No posts match.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
            <table className="min-w-full text-left text-xs" data-testid="posts-table">
              <thead className="bg-zinc-50"><tr>{["Date", "Post", "Platform", "Status", "Owner", ""].map((h) => <th key={h || "a"} className="px-3 py-2 font-semibold">{h || <span className="sr-only">Actions</span>}</th>)}</tr></thead>
              <tbody>
                {sorted.map((p) => (
                  <tr key={p.id} className="border-t border-zinc-100 align-top">
                    <td className="px-3 py-2">{fmtDate(p.scheduled_date)}{p.scheduled_time ? ` ${p.scheduled_time}` : ""}</td>
                    <td className="px-3 py-2"><button type="button" className="font-medium underline" onClick={() => setEditing(p)}>{p.title}</button><div>{label(POST_TYPES, p.post_type)} · {label(BUSINESSES, p.business)}</div></td>
                    <td className="px-3 py-2">{label(PLATFORMS, p.platform)}</td>
                    <td className="px-3 py-2">{statusChip(p.status)}</td>
                    <td className="px-3 py-2">{owner(p.owner_account_id)}</td>
                    <td className="whitespace-nowrap px-3 py-2"><button type="button" className={btn} onClick={() => duplicate(p)}>Duplicate</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <MonthGrid month={month} setMonth={setMonth} posts={rows} today={today} onOpen={(p) => setEditing(p)} />
      )}
      {editing && (
        <PostEditor
          data={data}
          post={editing === "new" ? null : editing}
          initial={editing === "new" ? draftFrom : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
          onDuplicate={editing !== "new" ? () => duplicate(editing) : undefined}
        />
      )}
    </section>
  );
}

function MonthGrid({ month, setMonth, posts, today, onOpen }: { month: string; setMonth: (m: string) => void; posts: Post[]; today: string; onOpen: (p: Post) => void }) {
  const [y, m] = month.split("-").map(Number);
  const first = `${month}-01`;
  const startDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: Array<string | null> = [...Array(startDow).fill(null), ...Array.from({ length: daysIn }, (_, i) => addDays(first, i))];
  while (cells.length % 7) cells.push(null);
  const shift = (d: number) => {
    const t = new Date(Date.UTC(y, m - 1 + d, 1));
    setMonth(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`);
  };
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const unscheduled = posts.filter((p) => !p.scheduled_date);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button type="button" className={btn} onClick={() => shift(-1)} aria-label="Previous month">←</button>
        <h2 className="w-40 text-center text-sm font-semibold">{title}</h2>
        <button type="button" className={btn} onClick={() => shift(1)} aria-label="Next month">→</button>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-zinc-200 bg-zinc-200 text-xs" data-testid="month-grid">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="bg-zinc-50 px-1 py-1 text-center font-semibold">{d}</div>)}
        {cells.map((d, i) => (
          <div key={i} className={`min-h-24 bg-white p-1 ${d === today ? "ring-2 ring-inset ring-emerald-500" : ""}`}>
            {d && <div className="text-right text-[11px]">{Number(d.slice(8))}</div>}
            {d && posts.filter((p) => p.scheduled_date === d).map((p) => (
              <button key={p.id} type="button" onClick={() => onOpen(p)} className="mb-0.5 block w-full truncate rounded border border-zinc-200 px-1 text-left">
                {statusChip(p.status)} {p.title}
              </button>
            ))}
          </div>
        ))}
      </div>
      {unscheduled.length > 0 && <p className="text-xs">No date yet: {unscheduled.map((p, i) => <span key={p.id}>{i > 0 && ", "}<button type="button" className="underline" onClick={() => onOpen(p)}>{p.title}</button></span>)}</p>}
    </div>
  );
}

function PostEditor({ data, post, initial, onClose, onSaved, onDuplicate }: { data: MarketingData; post: Post | null; initial: Partial<Post> | null; onClose: () => void; onSaved: () => void; onDuplicate?: () => void }) {
  const src = post ?? initial;
  const [v, setV] = useState({
    title: src?.title ?? "",
    business: (src?.business ?? "botaniqals") as string,
    formulation_product_id: src?.formulation_product_id ?? "",
    platform: src?.platform ?? "instagram",
    post_type: src?.post_type ?? "reel",
    status: src?.status ?? "idea",
    scheduled_date: src?.scheduled_date ?? "",
    scheduled_time: src?.scheduled_time ?? "",
    owner_account_id: src?.owner_account_id ?? "",
    caption: src?.caption ?? "",
    hashtags: src?.hashtags ?? "",
    project_url: src?.project_url ?? "",
    posted_url: src?.posted_url ?? "",
    posted_at: src?.posted_at ?? "",
    notes: src?.notes ?? "",
  });
  const [assetIds, setAssetIds] = useState<string[]>(src?.asset_ids ?? []);
  const [claimIds, setClaimIds] = useState<string[]>(src?.claim_ids ?? []);
  const [checked, setChecked] = useState(post?.risky_words_checked ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const words = activeWords(data);
  const risky = [...new Set(scanText(`${v.caption}\n${v.hashtags}`, words).map((m) => m.phrase))];
  const selectedClaims = data.claims.filter((c) => claimIds.includes(c.id));
  const unapproved = claimsReadyCheck(selectedClaims);
  const ready = isReadyStatus(v.status);
  const blockers: string[] = [];
  if (ready && !v.caption.trim()) blockers.push("Write the caption first.");
  if (ready && unapproved.length) blockers.push(`These claims aren't approved: ${unapproved.map((c) => `“${c.claim_text}”`).join(", ")}.`);
  if (ready && risky.length && !checked) blockers.push("Tick “I have checked these words”.");
  const save = async () => {
    setMessage(null);
    try {
      await savePostApi(post?.id ?? null, { ...v, formulation_product_id: v.formulation_product_id || null, owner_account_id: v.owner_account_id || null, asset_ids: assetIds, claim_ids: claimIds, risky_words_checked: checked });
      onSaved();
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
    }
  };
  const productClaims = data.claims.filter((c) => c.status !== "retired" && (!c.formulation_product_id || !v.formulation_product_id || c.formulation_product_id === v.formulation_product_id));
  const assets = data.assets.filter((a) => a.status !== "archived" || assetIds.includes(a.id));
  return (
    <Dialog title={post ? `Post: ${post.title}` : "New post"} onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <TextField name="post-title" label="Title" value={v.title} onChange={set("title")} required error={errors.title} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Select name="post-business" label="Business" value={v.business} onChange={set("business")} options={BUSINESSES} />
          <Select name="post-product" label="Product" value={v.formulation_product_id} onChange={set("formulation_product_id")} options={[{ value: "", label: "None" }, ...data.products.map((p) => ({ value: p.id, label: p.name }))]} />
          <Select name="post-platform" label="Platform" value={v.platform} onChange={set("platform")} options={PLATFORMS} />
          <Select name="post-type" label="Type" value={v.post_type} onChange={set("post_type")} options={POST_TYPES} />
          <Select name="post-status" label="Status" value={v.status} onChange={set("status")} options={POST_STATUSES.map((s) => ({ value: s.value, label: s.label }))} error={errors.status} />
          <TextField name="post-date" label="Date" type="date" value={v.scheduled_date} onChange={set("scheduled_date")} error={errors.scheduled_date} />
          <TextField name="post-time" label="Time" type="time" value={v.scheduled_time} onChange={set("scheduled_time")} error={errors.scheduled_time} />
          <Select name="post-owner" label="Owner" value={v.owner_account_id} onChange={set("owner_account_id")} options={[{ value: "", label: "Nobody" }, ...data.employees.map((e) => ({ value: e.id, label: e.name }))]} />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="f-post-caption" className="text-xs font-medium">Caption ({v.caption.length}/4000)</label>
            <div className="flex gap-1">
              <button type="button" className={btn} onClick={() => setTemplateOpen(true)}>Use template</button>
              <CopyButton text={[v.caption, v.hashtags].filter(Boolean).join("\n\n")} labelText="Copy caption and hashtags" />
            </div>
          </div>
          <textarea id="f-post-caption" rows={6} value={v.caption} onChange={(e) => set("caption")(e.target.value)} className={input} aria-invalid={!!errors.caption} />
          <p className="mt-1 text-[11px]">Only use claims from the approved list.</p>
          {templateNote && <p className={infoBox}>{templateNote}</p>}
        </div>
        <TextField name="post-hashtags" label="Hashtags" value={v.hashtags} onChange={set("hashtags")} error={errors.hashtags} />
        {risky.length > 0 && (
          <div className={warnBox} data-testid="risky-warning">
            <p>Words to check: {risky.map((w) => `“${w}”`).join(", ")}.</p>
            <label className="mt-1 flex items-center gap-2 font-medium"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I have checked these words</label>
          </div>
        )}
        <Picker title="Claims used" items={productClaims.map((c) => ({ id: c.id, label: c.claim_text, extra: CLAIM_STATUS[c.status].label, bad: c.status !== "approved" }))} selected={claimIds} onChange={setClaimIds} />
        <Picker title="Attached assets" items={assets.map((a) => ({ id: a.id, label: a.title, extra: label(ASSET_TYPES, a.asset_type) }))} selected={assetIds} onChange={setAssetIds} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TextField name="post-project" label="Editing project link" value={v.project_url} onChange={set("project_url")} placeholder="https://" error={errors.project_url} />
          <TextField name="post-posted-url" label="Posted URL" value={v.posted_url} onChange={set("posted_url")} placeholder="https://" error={errors.posted_url} />
          <TextField name="post-posted-at" label="Posted on" type="date" value={v.posted_at} onChange={set("posted_at")} error={errors.posted_at} />
        </div>
        <TextArea name="post-notes" label="Notes" value={v.notes} onChange={set("notes")} rows={2} error={errors.notes} />
        {blockers.length > 0 && (
          <div className={errorBox} role="alert" data-testid="ready-blockers">
            <p className="font-medium">Before this can be {POST_STATUSES.find((s) => s.value === v.status)?.label}:</p>
            <ul className="list-disc pl-4">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            {onDuplicate && <button type="button" className={btn} onClick={onDuplicate}>Duplicate</button>}
            {post && <button type="button" className={btn} onClick={() => setConfirmArchive(true)}>Archive</button>}
          </div>
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={onClose}>Cancel</button>
            <button type="button" className={btnPrimary} onClick={save} disabled={blockers.length > 0}>Save post</button>
          </div>
        </div>
      </div>
      {templateOpen && (
        <TemplatePicker
          data={data}
          productId={v.formulation_product_id}
          onClose={() => setTemplateOpen(false)}
          onUse={(text, unknown, missing) => {
            setV((s) => ({ ...s, caption: text }));
            setTemplateNote([unknown.length ? `Unknown placeholders left as typed: ${unknown.map((u) => `{${u}}`).join(", ")}.` : "", missing.length ? `No value for: ${missing.map((u) => `{${u}}`).join(", ")}.` : ""].filter(Boolean).join(" ") || null);
            setTemplateOpen(false);
          }}
        />
      )}
      {confirmArchive && post && (
        <ConfirmDialog title="Archive this post?" confirmLabel="Archive" busy={false} error={null} onConfirm={async () => { await archivePostApi(post.id, true); onSaved(); }} onClose={() => setConfirmArchive(false)}>
          <p>It leaves the calendar. Posts are never deleted.</p>
        </ConfirmDialog>
      )}
    </Dialog>
  );
}

function Picker({ title, items, selected, onChange }: { title: string; items: Array<{ id: string; label: string; extra?: string; bad?: boolean }>; selected: string[]; onChange: (ids: string[]) => void }) {
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium">{title} ({selected.length})</legend>
      {items.length === 0 ? (
        <p className="text-xs">None available.</p>
      ) : (
        <ul className="max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-zinc-200 p-1">
          {items.map((i) => (
            <li key={i.id}>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={selected.includes(i.id)} onChange={() => toggle(i.id)} />
                <span className="flex-1">{i.label}</span>
                {i.extra && <span className={i.bad ? "font-medium text-red-700" : ""}>{i.extra}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function templateVars(data: MarketingData, productId: string) {
  const product = data.products.find((p) => p.id === productId);
  const profile = data.profiles.find((p) => p.formulation_product_id === productId);
  return { product_name: product?.name, tagline: profile?.tagline, short_description: profile?.short_description, hashtags: profile?.hashtags, link: "" };
}

function TemplatePicker({ data, productId, onClose, onUse }: { data: MarketingData; productId: string; onClose: () => void; onUse: (text: string, unknown: string[], missing: string[]) => void }) {
  const list = data.templates.filter((t) => !t.archived_at);
  const [id, setId] = useState(list[0]?.id ?? "");
  const [link, setLink] = useState("");
  const t = list.find((x) => x.id === id);
  const result = t ? applyTemplate(t.body, { ...templateVars(data, productId), link }) : null;
  return (
    <Dialog title="Use a caption template" onClose={onClose} wide>
      <div className="space-y-3 text-black">
        {list.length === 0 ? (
          <p className="text-sm">No templates yet. Add one on the Templates tab.</p>
        ) : (
          <>
            <Select name="tpl" label="Template" value={id} onChange={setId} options={list.map((x) => ({ value: x.id, label: x.name }))} />
            <TextField name="tpl-link" label="Link for {link}" value={link} onChange={setLink} placeholder="https://" />
            {result && (
              <>
                <pre className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs">{result.text}</pre>
                {result.unknown.length > 0 && <p className={warnBox}>Unknown placeholders (left as typed): {result.unknown.map((u) => `{${u}}`).join(", ")}</p>}
                {result.missing.length > 0 && <p className={infoBox}>No value for: {result.missing.map((u) => `{${u}}`).join(", ")}</p>}
              </>
            )}
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} disabled={!result} onClick={() => result && onUse(result.text, result.unknown, result.missing)}>Use this caption</button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Templates -----------------------------------------------------------------------------------
export function TemplatesTab({ data, reload }: TabProps) {
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = data.templates.filter((t) => !!t.archived_at === showArchived);
  return (
    <section className="space-y-3">
      <p className={infoBox}>Placeholders: {TEMPLATE_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}. They fill from the product&apos;s profile when you use a template on a post.</p>
      {error && <p className={errorBox} role="alert">{error}</p>}
      <div className="flex items-center justify-between">
        <Checkbox name="tpl-archived" label="Show archived" checked={showArchived} onChange={setShowArchived} />
        <button type="button" className={btnPrimary} onClick={() => setEditing("new")}>New template</button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">No templates.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((t) => (
            <li key={t.id} className={`${card} space-y-1`}>
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">{t.name} {t.platform && <Badge>{label(PLATFORMS, t.platform)}</Badge>}</p>
                <div className="flex gap-1">
                  {!t.archived_at && <button type="button" className={btn} onClick={() => setEditing(t)}>Edit</button>}
                  <button
                    type="button"
                    className={btn}
                    onClick={async () => {
                      setError(null);
                      try {
                        await saveTemplateApi(t.id, t.archived_at ? { restore: true } : { archive: true });
                        await reload();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    {t.archived_at ? "Restore" : "Archive"}
                  </button>
                </div>
              </div>
              <pre className="whitespace-pre-wrap text-xs">{t.body}</pre>
            </li>
          ))}
        </ul>
      )}
      {editing && <TemplateDialog data={data} template={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
    </section>
  );
}

function TemplateDialog({ data, template, onClose, onSaved }: { data: MarketingData; template: Template | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ name: template?.name ?? "", platform: template?.platform ?? "", body: template?.body ?? "" });
  const [product, setProduct] = useState(data.products[0]?.id ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const preview = useMemo(() => applyTemplate(v.body, templateVars(data, product)), [v.body, data, product]);
  return (
    <Dialog title={template ? "Edit template" : "New template"} onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField name="t-name" label="Name" value={v.name} onChange={(x) => setV({ ...v, name: x })} required error={errors.name} />
          <Select name="t-platform" label="Platform" value={v.platform} onChange={(x) => setV({ ...v, platform: x })} options={[{ value: "", label: "Any" }, ...PLATFORMS]} />
        </div>
        <TextArea name="t-body" label={`Template (${v.body.length}/2000)`} value={v.body} onChange={(x) => setV({ ...v, body: x })} rows={6} error={errors.body} hint={`Placeholders: ${TEMPLATE_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`} />
        <Select name="t-preview-product" label="Preview with" value={product} onChange={setProduct} options={data.products.map((p) => ({ value: p.id, label: p.name }))} />
        <Preview title="Preview">
          <pre className="whitespace-pre-wrap text-xs">{preview.text}</pre>
          {preview.unknown.length > 0 && <p className="text-[11px] text-red-700">Unknown: {preview.unknown.map((u) => `{${u}}`).join(", ")}</p>}
          {preview.missing.length > 0 && <p className="text-[11px]">No value: {preview.missing.map((u) => `{${u}}`).join(", ")}</p>}
        </Preview>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={btnPrimary}
            onClick={async () => {
              try {
                await saveTemplateApi(template?.id ?? null, v);
                onSaved();
              } catch (e) {
                setErrors((e as GrowthApiError).fields ?? { name: (e as Error).message });
              }
            }}
          >
            Save template
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function Preview({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2">
      <p className="mb-1 text-xs font-semibold">{title}</p>
      {children}
    </div>
  );
}

// --- Settings (Admin only) ---------------------------------------------------------------------
export function SettingsTab({ data, reload }: TabProps) {
  const [phrase, setPhrase] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<{ id: string; phrase: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Risky-word watch list</h2>
      <p className={infoBox}>A starter list to catch wording that may need review. It is not a legal check.</p>
      {error && <p className={errorBox} role="alert">{error}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <TextField name="rw-phrase" label="Word or phrase" value={phrase} onChange={setPhrase} />
        <TextField name="rw-note" label="Note (optional)" value={note} onChange={setNote} />
        <button type="button" className={btnPrimary} onClick={async () => { if (await run(() => saveRiskyWordApi(null, { phrase, note }))) { setPhrase(""); setNote(""); } }}>Add</button>
      </div>
      <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white" data-testid="risky-words">
        {data.riskyWords.map((w) => (
          <li key={w.id} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm ${w.archived_at ? "opacity-60" : ""}`}>
            {editing?.id === w.id ? (
              <span className="flex flex-1 gap-2">
                <input aria-label="Phrase" value={editing.phrase} onChange={(e) => setEditing({ ...editing, phrase: e.target.value })} className={input} />
                <input aria-label="Note" value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} className={input} />
              </span>
            ) : (
              <span>
                <span className="font-medium">{w.phrase}</span>
                {w.note && <span className="ml-2 text-xs">{w.note}</span>}
                {w.archived_at && <span className="ml-2"><Badge>Archived</Badge></span>}
              </span>
            )}
            <span className="flex gap-1">
              {editing?.id === w.id ? (
                <>
                  <button type="button" className={btnPrimary} onClick={async () => { if (await run(() => saveRiskyWordApi(w.id, { phrase: editing.phrase, note: editing.note }))) setEditing(null); }}>Save</button>
                  <button type="button" className={btn} onClick={() => setEditing(null)}>Cancel</button>
                </>
              ) : (
                <>
                  {!w.archived_at && <button type="button" className={btn} onClick={() => setEditing({ id: w.id, phrase: w.phrase, note: w.note ?? "" })}>Edit</button>}
                  <button type="button" className={btn} onClick={() => run(() => saveRiskyWordApi(w.id, w.archived_at ? { restore: true } : { archive: true }))}>{w.archived_at ? "Restore" : "Archive"}</button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
