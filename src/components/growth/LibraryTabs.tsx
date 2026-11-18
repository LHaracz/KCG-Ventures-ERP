"use client";

/**
 * Marketing Hub › Ad Library and Pillars tabs, the library item editor (a
 * drawer on top of the tab), and the Closing lines section of the Templates
 * tab. Filters live in the URL (lib_*, pil_*), so they survive tab switches.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createPillarApi,
  createPremadeApi,
  premadeActionApi,
  premadeBulkApi,
  reletterApi,
  saveClosingLineApi,
  updatePillarApi,
  updatePremadeApi,
  type GrowthApiError,
  type MarketingData,
} from "@/lib/growth/client";
import {
  FLAG_KEYS,
  FLAG_LABEL,
  LIBRARY_PLATFORMS,
  displayName,
  hashPremadeText,
  nextFreeCode,
  premadeReadyCheck,
  premadeScanText,
  scanBoth,
  type FlagKey,
  type Hits,
  type ReletterPlan,
  type ScriptBeat,
} from "@/lib/growth/adLibrary";
import { PRODUCT_KEYS, PRODUCT_KEY_LABEL, parseDuration } from "@/lib/growth/playbookParse";
import { PLATFORM_LABEL } from "@/lib/growth/scheduling";
import type { Pillar, PremadeRow } from "@/lib/growth/libraryService";
import { Badge, Checkbox, Chip, ConfirmDialog, Dialog, ErrorSummary, Select, TextArea, TextField, btn, btnPrimary, card, errorBox, fmtDate, infoBox, input, warnBox } from "./GrowthUi";
import { listParam, useUrlParams } from "./useUrlParams";
import { CopyButton } from "./MarketingTabs";
import { NeedsSection, NeedsPanel } from "./LibraryNeeds";
import { AddToCalendarDialog } from "./LibraryCalendar";

type TabProps = { data: MarketingData; reload: () => Promise<void> };
const touch = "min-h-11";
const STATUS_LABEL: Record<string, string> = { idea: "Idea", drafting: "Drafting", ready: "Ready", paused: "Paused" };
const STATUS_TONE: Record<string, "zinc" | "blue" | "green" | "amber"> = { idea: "zinc", drafting: "blue", ready: "green", paused: "amber" };
const INTENT_LABEL: Record<string, string> = { organic: "Organic", paid: "Paid", both: "Organic and paid" };
const FORMAT_LABEL: Record<string, string> = { carousel: "Carousel", single_image: "Single image", story: "Story", unknown: "Not set" };
const BUSINESS_OPTIONS = [
  { value: "botaniqals", label: "BotanIQals" },
  { value: "minileaf", label: "MiniLeaf" },
  { value: "brand", label: "Brand (both)" },
];
const ATTENTION = [
  { key: "needs", label: "Needs assets" },
  { key: "permission", label: "Needs customer permission" },
  { key: "avoid", label: "Matches avoid list" },
  { key: "watch", label: "Matches watch words" },
  { key: "flag", label: "Has an open flag" },
  { key: "unscheduled", label: "Not yet scheduled" },
] as const;

export const activeRisky = (d: MarketingData) => d.riskyWords.filter((w) => !w.archived_at).map((w) => w.phrase);
export const activeAvoid = (d: MarketingData) => d.avoidPhrases.filter((w) => !w.archived_at).map((w) => w.phrase);
export const hitsFor = (d: MarketingData, p: { hook?: string | null; caption?: string | null; script_beats?: ScriptBeat[] | null }): Hits =>
  scanBoth(premadeScanText(p), activeRisky(d), activeAvoid(d));
const openFlags = (p: PremadeRow) => p.flags.filter((f) => !f.dismissed_at);
const openNeeds = (p: PremadeRow) => p.asset_needs.filter((n) => n.status !== "ready");
const fmtDuration = (p: PremadeRow) =>
  p.duration_text || (p.duration_min_seconds !== null ? `${p.duration_min_seconds}–${p.duration_max_seconds ?? p.duration_min_seconds}s` : "—");

/** A panel on top of the tab: full screen on a phone, a wide right-hand drawer on larger screens. */
export function Drawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex h-full w-full max-w-4xl flex-col bg-white text-black shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <button type="button" className={`${btn} ${touch}`} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
        {footer && <div className="border-t border-zinc-200 p-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Text with the matched watch words and avoid phrases highlighted. */
export function Highlighted({ text, hits }: { text: string; hits: Hits }) {
  const phrases = [...hits.avoid.map((h) => ({ p: h.phrase, avoid: true })), ...hits.risky.map((h) => ({ p: h.phrase, avoid: false }))];
  if (!text || !phrases.length) return <>{text}</>;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}'’])(${phrases.map((x) => x.p.split(/\s+/).map(esc).join("\\s+")).join("|")})(?![\\p{L}\\p{N}'’])`, "giu");
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    parts.push(text.slice(last, m.index));
    const isAvoid = phrases.some((x) => x.avoid && x.p.toLowerCase() === m![0].toLowerCase().replace(/\s+/g, " "));
    parts.push(
      <mark key={m.index} className={isAvoid ? "rounded bg-red-200 px-0.5 text-black" : "rounded bg-amber-200 px-0.5 text-black"}>
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

// --- Pillars tab ----------------------------------------------------------------------------------
export function PillarsTab({ data, reload }: TabProps) {
  const url = useUrlParams();
  const showArchived = url.get("pil_archived") === "1";
  const [editing, setEditing] = useState<Pillar | "new" | null>(null);
  const [archiving, setArchiving] = useState<Pillar | null>(null);
  const [plan, setPlan] = useState<ReletterPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = data.pillars.filter((p) => showArchived || !p.archived_at);
  const itemCount = (id: string) => data.premades.filter((p) => p.pillar_id === id && !p.archived_at).length;
  const lastScheduled = (id: string) => {
    const ids = new Set(data.premades.filter((p) => p.pillar_id === id).map((p) => p.id));
    return data.posts.filter((p) => !p.archived_at && p.premade_post_id && ids.has(p.premade_post_id) && p.scheduled_date).map((p) => p.scheduled_date!).sort().pop() ?? null;
  };
  const preview = async () => {
    setError(null);
    try {
      setPlan((await reletterApi(false)).plan);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="space-y-3">
      <p className={infoBox}>Each pillar has a letter. Library items are named &ldquo;{"{letter}"} - {"{title}"}&rdquo;, so changing a letter or name changes how items are named here. Calendar entries that already exist keep their titles.</p>
      {error && <p className={errorBox} role="alert">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Checkbox name="pil-archived" label="Show archived" checked={showArchived} onChange={(v) => url.set({ pil_archived: v ? "1" : null })} />
        <div className="flex gap-2">
          <button type="button" className={btn} onClick={preview}>Re-letter alphabetically</button>
          <button type="button" className={btnPrimary} onClick={() => setEditing("new")} disabled={!nextFreeCode(data.pillars)}>Add pillar</button>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">No pillars yet. Add one to start the Ad Library.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full text-left text-xs" data-testid="pillars-table">
            <thead className="bg-zinc-50">
              <tr>{["Letter", "Name", "Description", "Recurring", "Library items", "Last scheduled", ""].map((h) => <th key={h || "a"} className="px-3 py-2 font-semibold">{h || <span className="sr-only">Actions</span>}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-zinc-100 align-top" data-testid="pillar-row">
                  <td className="px-3 py-2 text-base font-semibold">{p.code}</td>
                  <td className="px-3 py-2 font-medium">{p.name}{p.archived_at && <div><Badge>Archived</Badge></div>}</td>
                  <td className="max-w-md px-3 py-2">{p.description ?? "—"}</td>
                  <td className="px-3 py-2">{p.recurring ? "Yes" : "No"}</td>
                  <td className="px-3 py-2">{itemCount(p.id)}</td>
                  <td className="px-3 py-2">{fmtDate(lastScheduled(p.id))}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="flex justify-end gap-1">
                      {!p.archived_at && <button type="button" className={btn} onClick={() => setEditing(p)}>Edit</button>}
                      {!p.archived_at ? (
                        <button type="button" className={btn} onClick={() => setArchiving(p)}>Archive</button>
                      ) : (
                        <button type="button" className={btn} onClick={async () => { setError(null); try { await updatePillarApi(p.id, { restore: true }); await reload(); } catch (e) { setError((e as Error).message); } }}>Restore</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <PillarDialog data={data} pillar={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
      {archiving && <ArchivePillarDialog data={data} pillar={archiving} onClose={() => setArchiving(null)} onDone={() => { setArchiving(null); void reload(); }} />}
      {plan && (
        <ConfirmDialog
          title="Re-letter alphabetically"
          confirmLabel={plan.changes.length ? "Apply new letters" : "Close"}
          busy={busy}
          error={error}
          onConfirm={async () => {
            if (!plan.changes.length) return setPlan(null);
            setBusy(true);
            try {
              await reletterApi(true);
              setPlan(null);
              await reload();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          onClose={() => setPlan(null)}
        >
          {plan.changes.length === 0 ? (
            <p>The letters already follow the alphabetical order of the names.</p>
          ) : (
            <div className="space-y-2 text-sm" data-testid="reletter-preview">
              <ul>{plan.changes.map((c) => <li key={c.id}>{c.from} → {c.to}: {c.name}</li>)}</ul>
              <p className="font-medium">{plan.affectedItems.length} library item{plan.affectedItems.length === 1 ? "" : "s"} will show a new name.</p>
              <ul className="max-h-40 overflow-y-auto text-xs">{plan.affectedItems.slice(0, 50).map((i) => <li key={i.id}>{i.before} → {i.after}</li>)}</ul>
              <p className="text-xs">Calendar entries that already exist keep their titles.</p>
            </div>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

function PillarDialog({ data, pillar, onClose, onSaved }: { data: MarketingData; pillar: Pillar | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ code: pillar?.code ?? nextFreeCode(data.pillars) ?? "", name: pillar?.name ?? "", description: pillar?.description ?? "", recurring: pillar?.recurring ?? false });
  const [confirming, setConfirming] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const used = new Set(data.pillars.filter((p) => !p.archived_at && p.id !== pillar?.id).map((p) => p.code));
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).filter((c) => !used.has(c));
  const affected = pillar ? data.premades.filter((p) => p.pillar_id === pillar.id && !p.archived_at) : [];
  const renames = !!pillar && (v.code !== pillar.code) && affected.length > 0;
  const save = async () => {
    setMessage(null);
    try {
      if (pillar) await updatePillarApi(pillar.id, v);
      else await createPillarApi(v);
      onSaved();
    } catch (e) {
      setConfirming(false);
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
    }
  };
  return (
    <Dialog title={pillar ? `Edit pillar ${pillar.code}` : "New pillar"} onClose={onClose}>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <Select name="pillar-code" label="Letter" value={v.code} onChange={(x) => setV({ ...v, code: x })} options={letters.map((c) => ({ value: c, label: c }))} error={errors.code} />
        <TextField name="pillar-name" label="Name" value={v.name} onChange={(x) => setV({ ...v, name: x })} required error={errors.name} />
        <TextArea name="pillar-description" label={`Description (${v.description.length}/500)`} value={v.description} onChange={(x) => setV({ ...v, description: x })} rows={3} error={errors.description} />
        <Checkbox name="pillar-recurring" label="Recurring" checked={v.recurring} onChange={(x) => setV({ ...v, recurring: x })} />
        {confirming && (
          <div className={warnBox} data-testid="rename-preview">
            <p className="font-medium">{affected.length} library item{affected.length === 1 ? "" : "s"} will show a new name.</p>
            <ul className="mt-1">{affected.slice(0, 10).map((p) => <li key={p.id}>{p.display_name} → {displayName(v.code, p.title)}</li>)}</ul>
            {affected.length > 10 && <p>…and {affected.length - 10} more.</p>}
            <p className="mt-1">Calendar entries that already exist keep their titles.</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          {renames && !confirming ? (
            <button type="button" className={btnPrimary} onClick={() => setConfirming(true)}>Save</button>
          ) : (
            <button type="button" className={btnPrimary} onClick={save}>{confirming ? "Confirm and save" : "Save"}</button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ArchivePillarDialog({ data, pillar, onClose, onDone }: { data: MarketingData; pillar: Pillar; onClose: () => void; onDone: () => void }) {
  const inUse = data.premades.filter((p) => p.pillar_id === pillar.id && !p.archived_at);
  const others = data.pillars.filter((p) => !p.archived_at && p.id !== pillar.id);
  const [to, setTo] = useState(others[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = others.find((p) => p.id === to);
  return (
    <ConfirmDialog
      title={inUse.length ? `Move items out of ${pillar.code} - ${pillar.name}` : `Archive ${pillar.code} - ${pillar.name}?`}
      confirmLabel={inUse.length ? `Move ${inUse.length} item${inUse.length === 1 ? "" : "s"}` : "Archive"}
      busy={busy}
      error={error}
      onConfirm={async () => {
        setBusy(true);
        setError(null);
        try {
          if (inUse.length) await updatePillarApi(pillar.id, { move_items_to: to });
          else await updatePillarApi(pillar.id, { archive: true });
          onDone();
        } catch (e) {
          setError((e as Error).message);
          setBusy(false);
        }
      }}
      onClose={onClose}
    >
      {inUse.length ? (
        <div className="space-y-2 text-sm">
          <p className={warnBox}>{inUse.length} library item{inUse.length === 1 ? " uses" : "s use"} this pillar, so it can&apos;t be archived yet. Move them to another pillar first, then archive it.</p>
          <Select name="move-to" label="Move items to" value={to} onChange={setTo} options={others.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` }))} />
          {target && <ul className="max-h-32 overflow-y-auto text-xs">{inUse.slice(0, 10).map((p) => <li key={p.id}>{p.display_name} → {displayName(target.code, p.title)}</li>)}</ul>}
        </div>
      ) : (
        <p>Archived pillars stay on existing items and calendar entries; they just can&apos;t be chosen for new items.</p>
      )}
    </ConfirmDialog>
  );
}

// --- Ad Library tab -----------------------------------------------------------------------------------
export function AdLibraryTab({ data, reload }: TabProps) {
  const url = useUrlParams();
  const cat = url.get("lib_cat") === "picture_post" ? "picture_post" : "reel";
  const f = {
    q: url.get("lib_q"),
    pillar: url.get("lib_pillar"),
    series: url.get("lib_series"),
    status: url.get("lib_status"),
    intent: url.get("lib_intent"),
    product: url.get("lib_product"),
    recurring: url.get("lib_recurring") === "1",
    platform: url.get("lib_platform"),
    att: listParam(url.get("lib_att")),
    flag: url.get("lib_flag"),
    paused: url.get("lib_paused") === "1",
    sort: url.get("lib_sort") === "playbook" ? "playbook" : "pillar",
  };
  const openId = url.get("item");
  const [newCat, setNewCat] = useState<"reel" | "picture_post" | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<PremadeRow | null>(null);
  const [needsOpen, setNeedsOpen] = useState(url.get("lib_needs") === "1");
  const [error, setError] = useState<string | null>(null);
  const pillarById = useMemo(() => new Map(data.pillars.map((p) => [p.id, p])), [data.pillars]);
  const seriesById = useMemo(() => new Map(data.series.map((s) => [s.id, s])), [data.series]);
  const live = data.premades.filter((p) => !p.archived_at);
  const hits = useMemo(() => new Map(live.map((p) => [p.id, hitsFor(data, p)])), [live, data]);
  const matches = (p: PremadeRow, skipAtt?: string) => {
    if (!f.paused && p.status === "paused") return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (![p.display_name, p.title, p.hook ?? "", p.caption ?? ""].some((s) => s.toLowerCase().includes(q))) return false;
    }
    if (f.pillar && p.pillar_id !== f.pillar) return false;
    if (f.series && p.series_id !== f.series) return false;
    if (f.status && p.status !== f.status) return false;
    if (f.intent && p.intent !== f.intent) return false;
    if (f.product && !p.products_mentioned.includes(f.product)) return false;
    if (f.recurring && !p.is_recurring) return false;
    if (f.platform && !p.platforms.includes(f.platform)) return false;
    for (const a of f.att) if (a !== skipAtt && !attention(p, a)) return false;
    return true;
  };
  const attention = (p: PremadeRow, a: string) => {
    const h = hits.get(p.id)!;
    if (a === "needs") return openNeeds(p).length > 0;
    if (a === "permission") return p.needs_customer_permission && !p.permission_confirmed_at;
    if (a === "avoid") return h.avoid.length > 0;
    if (a === "watch") return h.risky.length > 0;
    if (a === "flag") return f.flag ? openFlags(p).some((x) => x.flag_key === f.flag) : openFlags(p).length > 0;
    if (a === "unscheduled") return !p.next_scheduled && !p.last_posted;
    return true;
  };
  const inCat = live.filter((p) => p.category === cat);
  const rows = inCat.filter((p) => matches(p)).sort((a, b) => {
    if (f.sort === "playbook") return a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name);
    const pa = pillarById.get(a.pillar_id)?.code ?? "";
    const pb = pillarById.get(b.pillar_id)?.code ?? "";
    return pa.localeCompare(pb) || (a.series_position ?? 9999) - (b.series_position ?? 9999) || a.title.localeCompare(b.title);
  });
  const count = (c: string) => live.filter((p) => p.category === c && matches(p)).length;
  const toggleAtt = (k: string) => url.set({ lib_att: (f.att.includes(k) ? f.att.filter((x) => x !== k) : [...f.att, k]).join(",") || null });
  const open = data.premades.find((p) => p.id === openId) ?? null;
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(r.id));
  useEffect(() => {
    // Drop selections that are no longer visible (filter change or reload).
    setSelected((s) => s.filter((id) => rows.some((r) => r.id === id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => r.id).join(",")]);

  if (data.pillars.filter((p) => !p.archived_at).length === 0) {
    return <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">Add a pillar on the Pillars tab first. Every library item belongs to a pillar.</p>;
  }
  return (
    <section className="space-y-3">
      {error && <p className={errorBox} role="alert">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => setNewCat("reel")}>New reel</button>
        <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => setNewCat("picture_post")}>New picture post</button>
        <button type="button" className={`${btn} ${touch}`} onClick={() => { setNeedsOpen(true); url.set({ lib_needs: "1" }); }}>Needs</button>
        <input aria-label="Search the library" placeholder="Search name, hook or caption" value={f.q} onChange={(e) => url.set({ lib_q: e.target.value })} className={`${input} w-64`} />
      </div>
      <div className="flex gap-1 border-b border-zinc-200" role="tablist" aria-label="Library category">
        {(["reel", "picture_post"] as const).map((c) => (
          <button key={c} type="button" role="tab" aria-selected={cat === c} onClick={() => url.set({ lib_cat: c === "reel" ? null : c })} className={`border-b-2 px-3 py-2 text-sm font-medium ${cat === c ? "border-emerald-600" : "border-transparent"}`} data-testid={`lib-sub-${c}`}>
            {c === "reel" ? "Reels" : "Picture posts"} ({count(c)})
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <select aria-label="Pillar" value={f.pillar} onChange={(e) => url.set({ lib_pillar: e.target.value })} className={`${input} w-44`}><option value="">All pillars</option>{data.pillars.filter((p) => !p.archived_at).map((p) => <option key={p.id} value={p.id}>{p.code} - {p.name}</option>)}</select>
        <select aria-label="Series" value={f.series} onChange={(e) => url.set({ lib_series: e.target.value })} className={`${input} w-44`}><option value="">All series</option>{data.series.filter((s) => !s.archived_at).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select aria-label="Status" value={f.status} onChange={(e) => url.set({ lib_status: e.target.value })} className={`${input} w-32`}><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select aria-label="Intent" value={f.intent} onChange={(e) => url.set({ lib_intent: e.target.value })} className={`${input} w-36`}><option value="">Any intent</option>{Object.entries(INTENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select aria-label="Product" value={f.product} onChange={(e) => url.set({ lib_product: e.target.value })} className={`${input} w-36`}><option value="">Any product</option>{PRODUCT_KEYS.map((k) => <option key={k} value={k}>{PRODUCT_KEY_LABEL[k]}</option>)}</select>
        <select aria-label="Platform" value={f.platform} onChange={(e) => url.set({ lib_platform: e.target.value })} className={`${input} w-36`}><option value="">Any platform</option>{LIBRARY_PLATFORMS.map((k) => <option key={k} value={k}>{PLATFORM_LABEL[k]}</option>)}</select>
        <Checkbox name="lib-recurring" label="Recurring" checked={f.recurring} onChange={(v) => url.set({ lib_recurring: v ? "1" : null })} />
        <Checkbox name="lib-paused" label="Show paused" checked={f.paused} onChange={(v) => url.set({ lib_paused: v ? "1" : null })} />
        <select aria-label="Sort" value={f.sort} onChange={(e) => url.set({ lib_sort: e.target.value === "playbook" ? "playbook" : null })} className={`${input} w-40`}>
          <option value="pillar">Pillar, then series</option>
          <option value="playbook">Playbook order</option>
        </select>
      </div>
      <fieldset className="flex flex-wrap items-center gap-2" aria-label="Needs attention">
        <legend className="mr-1 text-xs font-semibold">Needs attention:</legend>
        {ATTENTION.map((a) => {
          const n = inCat.filter((p) => matches(p, a.key) && attention(p, a.key)).length;
          const on = f.att.includes(a.key);
          return (
            <button key={a.key} type="button" aria-pressed={on} onClick={() => toggleAtt(a.key)} className={`rounded-full px-3 py-1 text-xs ring-1 ${on ? "bg-emerald-100 ring-emerald-500 font-semibold" : "bg-white ring-zinc-300"}`}>
              {a.label} ({n})
            </button>
          );
        })}
        {f.att.includes("flag") && (
          <select aria-label="Flag type" value={f.flag} onChange={(e) => url.set({ lib_flag: e.target.value })} className={`${input} w-48`}>
            <option value="">Any open flag</option>
            {FLAG_KEYS.map((k) => <option key={k} value={k}>{FLAG_LABEL[k]}</option>)}
          </select>
        )}
      </fieldset>

      {selected.length > 0 && (
        <div className={`${infoBox} flex flex-wrap items-center gap-2`} data-testid="bulk-bar">
          <span className="font-medium">{selected.length} selected</span>
          <button type="button" className={btn} onClick={() => act(() => premadeBulkApi({ ids: selected, action: "pause" }))}>Pause</button>
          <button type="button" className={btn} onClick={() => act(() => premadeBulkApi({ ids: selected, action: "reactivate" }))}>Reactivate</button>
          <button type="button" className={btn} onClick={() => setBulk("set_pillar")}>Set pillar</button>
          <button type="button" className={btn} onClick={() => setBulk("set_series")}>Set series</button>
          <button type="button" className={btn} onClick={() => setBulk("dismiss_flag")}>Dismiss a flag</button>
          <button type="button" className={btn} onClick={() => setBulk("archive")}>Archive</button>
          <button type="button" className={btn} onClick={() => setSelected([])}>Clear</button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">{inCat.length === 0 ? `No ${cat === "reel" ? "reels" : "picture posts"} yet.` : "Nothing matches these filters."}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full text-left text-xs" data-testid="library-table">
            <thead className="bg-zinc-50">
              <tr>
                <th className="px-2 py-2"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? [] : rows.map((r) => r.id))} /></th>
                {["Name", "Pillar", "Series", "Format", "Status", "Flags", "Calendar", ""].map((h) => <th key={h || "a"} className="px-3 py-2 font-semibold">{h || <span className="sr-only">Actions</span>}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const pil = pillarById.get(p.pillar_id);
                const h = hits.get(p.id)!;
                const flags = openFlags(p);
                const needs = openNeeds(p).length;
                return (
                  <tr key={p.id} className="border-t border-zinc-100 align-top" data-testid="library-row">
                    <td className="px-2 py-2"><input type="checkbox" aria-label={`Select ${p.display_name}`} checked={selected.includes(p.id)} onChange={() => setSelected((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))} /></td>
                    <td className="max-w-sm px-3 py-2">
                      <button type="button" className="text-left font-medium underline" onClick={() => url.set({ item: p.id })}>{p.display_name}</button>
                      {flags.some((x) => x.flag_key === "auto_name") && <span className="ml-1"><Chip tone="blue">Auto name</Chip></span>}
                    </td>
                    <td className="px-3 py-2">{pil ? `${pil.code} - ${pil.name}` : "—"}</td>
                    <td className="px-3 py-2">{p.series_id ? seriesById.get(p.series_id)?.name ?? "—" : "—"}{p.series_position ? ` #${p.series_position}` : ""}</td>
                    <td className="px-3 py-2">{p.category === "picture_post" ? FORMAT_LABEL[p.picture_format ?? "unknown"] : fmtDuration(p)}</td>
                    <td className="px-3 py-2"><Chip tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Chip></td>
                    <td className="px-3 py-2">
                      <div className="flex max-w-xs flex-wrap gap-1" data-testid="row-flags">
                        {needs > 0 && <Chip tone="amber">{needs} asset{needs === 1 ? "" : "s"} needed</Chip>}
                        {h.avoid.length > 0 && <Chip tone="red">Avoid list</Chip>}
                        {h.risky.length > 0 && <Chip tone="amber">Watch words</Chip>}
                        {p.needs_customer_permission && !p.permission_confirmed_at && <Chip tone="amber">Permission</Chip>}
                        {flags.filter((x) => x.flag_key !== "auto_name").map((x) => <Chip key={x.id} tone="blue">{FLAG_LABEL[x.flag_key]}</Chip>)}
                      </div>
                    </td>
                    <td className="px-3 py-2">{p.next_scheduled ? `Next: ${fmtDate(p.next_scheduled)}` : p.last_posted ? `Posted: ${fmtDate(p.last_posted)}` : "Not scheduled"}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button type="button" className={btn} onClick={() => url.set({ item: p.id })}>Open</button>
                        <button type="button" className={btn} onClick={() => setScheduling(p)} disabled={p.status === "paused"} title={p.status === "paused" ? "Paused: reactivate it first" : undefined}>Add to calendar</button>
                        <button type="button" className={btn} onClick={() => act(async () => url.set({ item: (await premadeActionApi(p.id, { action: "duplicate" })).id }))}>Duplicate</button>
                        <button type="button" className={btn} onClick={() => act(() => premadeActionApi(p.id, { action: p.status === "paused" ? "reactivate" : "pause" }))}>{p.status === "paused" ? "Reactivate" : "Pause"}</button>
                        <button type="button" className={btn} onClick={() => act(() => premadeActionApi(p.id, { action: "archive" }))}>Archive</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(open || newCat) && (
        <LibraryEditor
          key={open?.id ?? `new-${newCat}`}
          data={data}
          item={open}
          category={open?.category ?? newCat!}
          onClose={() => { setNewCat(null); url.set({ item: null }); }}
          onSaved={async (id) => { setNewCat(null); await reload(); url.set({ item: id }); }}
          onSchedule={(p) => setScheduling(p)}
          reload={reload}
        />
      )}
      {bulk && <BulkDialog data={data} action={bulk} ids={selected} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSelected([]); void reload(); }} />}
      {scheduling && <AddToCalendarDialog data={data} premade={scheduling} onClose={() => setScheduling(null)} onDone={() => { setScheduling(null); void reload(); }} />}
      {needsOpen && <NeedsPanel data={data} reload={reload} onClose={() => { setNeedsOpen(false); url.set({ lib_needs: null }); }} />}
    </section>
  );
}

function BulkDialog({ data, action, ids, onClose, onDone }: { data: MarketingData; action: string; ids: string[]; onClose: () => void; onDone: () => void }) {
  const [pillar, setPillar] = useState(data.pillars.find((p) => !p.archived_at)?.id ?? "");
  const [series, setSeries] = useState("");
  const [flag, setFlag] = useState<FlagKey>("auto_name");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titles: Record<string, string> = { set_pillar: "Set pillar", set_series: "Set series", dismiss_flag: "Dismiss a flag", archive: "Archive items" };
  return (
    <ConfirmDialog
      title={`${titles[action]} (${ids.length} selected)`}
      confirmLabel={titles[action]}
      busy={busy}
      error={error}
      onConfirm={async () => {
        setBusy(true);
        setError(null);
        try {
          await premadeBulkApi({ ids, action, pillar_id: pillar, series_id: series || null, flag_key: flag, note });
          onDone();
        } catch (e) {
          setError((e as Error).message);
          setBusy(false);
        }
      }}
      onClose={onClose}
    >
      {action === "set_pillar" && (
        <>
          <Select name="bulk-pillar" label="Pillar" value={pillar} onChange={setPillar} options={data.pillars.filter((p) => !p.archived_at).map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` }))} />
          <p className="text-xs">Names change to the new letter. If a title already exists in that pillar, nothing changes and the clashing titles are listed.</p>
        </>
      )}
      {action === "set_series" && <Select name="bulk-series" label="Series" value={series} onChange={setSeries} options={[{ value: "", label: "No series" }, ...data.series.filter((s) => !s.archived_at).map((s) => ({ value: s.id, label: s.name }))]} />}
      {action === "dismiss_flag" && (
        <>
          <Select name="bulk-flag" label="Flag" value={flag} onChange={(x) => setFlag(x as FlagKey)} options={FLAG_KEYS.map((k) => ({ value: k, label: FLAG_LABEL[k] }))} />
          <TextField name="bulk-note" label="Note (required)" value={note} onChange={setNote} placeholder="Why these can be dismissed" />
        </>
      )}
      {action === "archive" && <p>Archived items leave the library. Calendar entries made from them stay as they are.</p>}
    </ConfirmDialog>
  );
}

// --- Editor --------------------------------------------------------------------------------------------
type Form = {
  title: string;
  pillar_id: string;
  series_id: string;
  series_position: string;
  business: string;
  status: string;
  intent: string;
  is_recurring: boolean;
  platforms: string[];
  products_mentioned: string[];
  picture_format: string;
  hook: string;
  caption: string;
  hashtags: string;
  cta_text: string;
  style_tag: string;
  duration_text: string;
  script_beats: Array<{ time: string; beat: string; k: number }>;
  visual_direction: string;
  why_it_converts: string;
  visual_notes: string;
  best_window_text: string;
  best_window_why: string;
  needs_customer_permission: boolean;
  notes: string;
  claim_ids: string[];
};
let beatKey = 0;
const toForm = (p: PremadeRow | null, data: MarketingData, category: string): Form => ({
  title: p?.title ?? "",
  pillar_id: p?.pillar_id ?? data.pillars.find((x) => !x.archived_at)?.id ?? "",
  series_id: p?.series_id ?? "",
  series_position: p?.series_position ? String(p.series_position) : "",
  business: p?.business ?? "botaniqals",
  status: p?.status ?? "drafting",
  intent: p?.intent ?? "organic",
  is_recurring: p?.is_recurring ?? false,
  platforms: p?.platforms ?? (category === "reel" ? ["instagram", "tiktok"] : ["instagram"]),
  products_mentioned: p?.products_mentioned ?? [],
  picture_format: p?.picture_format ?? (category === "picture_post" ? "single_image" : ""),
  hook: p?.hook ?? "",
  caption: p?.caption ?? "",
  hashtags: p?.hashtags ?? "",
  cta_text: p?.cta_text ?? "",
  style_tag: p?.style_tag ?? "",
  duration_text: p?.duration_text ?? "",
  script_beats: (p?.script_beats ?? []).map((b) => ({ time: b.time ?? "", beat: b.beat, k: ++beatKey })),
  visual_direction: p?.visual_direction ?? "",
  why_it_converts: p?.why_it_converts ?? "",
  visual_notes: p?.visual_notes ?? "",
  best_window_text: p?.best_window_text ?? "",
  best_window_why: p?.best_window_why ?? "",
  needs_customer_permission: p?.needs_customer_permission ?? false,
  notes: p?.notes ?? "",
  claim_ids: p?.claim_ids ?? [],
});
const formBody = (v: Form) => ({ ...v, script_beats: v.script_beats.map(({ time, beat }) => ({ time, beat })), series_position: v.series_position || null, series_id: v.series_id || null });

function LibraryEditor({
  data,
  item,
  category,
  onClose,
  onSaved,
  onSchedule,
  reload,
}: {
  data: MarketingData;
  item: PremadeRow | null;
  category: "reel" | "picture_post";
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
  onSchedule: (p: PremadeRow) => void;
  reload: () => Promise<void>;
}) {
  const [v, setV] = useState<Form>(() => toForm(item, data, category));
  const initial = useRef(JSON.stringify(formBody(toForm(item, data, category))));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [closingOpen, setClosingOpen] = useState(false);
  const set = <K extends keyof Form>(k: K) => (x: Form[K]) => setV((s) => ({ ...s, [k]: x }));
  const dirty = JSON.stringify(formBody(v)) !== initial.current;
  const pillar = data.pillars.find((p) => p.id === v.pillar_id);
  const series = data.series.find((s) => s.id === v.series_id);
  const dupe = data.premades.find((p) => !p.archived_at && p.id !== item?.id && p.pillar_id === v.pillar_id && p.title.trim().toLowerCase() === v.title.trim().toLowerCase() && v.title.trim());
  const beats = v.script_beats.map(({ time, beat }) => ({ time, beat }));
  const hits = hitsFor(data, { hook: v.hook, caption: v.caption, script_beats: beats });
  const hash = hashPremadeText({ hook: v.hook, caption: v.caption, script_beats: beats.filter((b) => b.time || b.beat).map((b) => (b.time ? b : { beat: b.beat })) });
  const selectedClaims = data.claims.filter((c) => v.claim_ids.includes(c.id));
  const blockers = premadeReadyCheck({
    premade: { category, hook: v.hook, caption: v.caption, script_beats: beats, cta_text: v.cta_text, asset_needs: item?.asset_needs ?? [], needs_customer_permission: v.needs_customer_permission, permission_confirmed_at: item?.permission_confirmed_at ?? null, risky_ack_hash: item?.risky_ack_hash ?? null },
    selectedClaims,
    hits,
    currentTextHash: hash,
  });
  const save = async () => {
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      const body = formBody(v);
      const r = item ? await updatePremadeApi(item.id, body) : await createPremadeApi({ ...body, category });
      initial.current = JSON.stringify(body);
      setNotice(r.notice);
      await onSaved(r.id);
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
    } finally {
      setBusy(false);
    }
  };
  const action = async (body: Record<string, unknown>) => {
    if (!item) return;
    setMessage(null);
    try {
      await premadeActionApi(item.id, body);
      await reload();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  const moveBeat = (from: number, to: number) =>
    setV((s) => {
      if (to < 0 || to >= s.script_beats.length || from === to) return s;
      const next = [...s.script_beats];
      const [x] = next.splice(from, 1);
      next.splice(to, 0, x);
      return { ...s, script_beats: next };
    });
  const flags = item?.flags ?? [];
  const title = item ? item.display_name : category === "reel" ? "New reel" : "New picture post";
  const scriptText = [v.hook, ...v.script_beats.map((b) => `${b.time ? `${b.time}  ` : ""}${b.beat}`)].filter(Boolean).join("\n");
  const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

  return (
    <Drawer
      title={title}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {item && <button type="button" className={`${btn} ${touch}`} onClick={() => onSchedule(item)} disabled={item.status === "paused"}>Add to calendar</button>}
            {item && <button type="button" className={`${btn} ${touch}`} onClick={() => action({ action: "duplicate" })}>Duplicate</button>}
          </div>
          <div className="flex gap-2">
            <button type="button" className={`${btn} ${touch}`} onClick={onClose}>{dirty ? "Discard" : "Close"}</button>
            <button type="button" className={`${btnPrimary} ${touch}`} onClick={save} disabled={busy || !!dupe}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
      }
    >
      <ErrorSummary message={message} errors={errors} />
      {notice && <p className={warnBox} role="status">{notice}</p>}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select name="pm-pillar" label="Pillar" value={v.pillar_id} onChange={set("pillar_id")} options={data.pillars.filter((p) => !p.archived_at || p.id === v.pillar_id).map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` }))} error={errors.pillar_id} />
        <div className="sm:col-span-2">
          <TextField name="pm-title" label={`Title (${v.title.length}/150)`} value={v.title} onChange={set("title")} required error={errors.title || (dupe ? "Another item in this pillar already has this title." : undefined)} />
        </div>
        <p className="text-sm sm:col-span-3" data-testid="display-name-preview">Name: <span className="font-semibold">{pillar ? displayName(pillar.code, v.title || "…") : "…"}</span></p>
      </section>

      {flags.length > 0 && <FlagsSection flags={flags} onDismiss={(k) => action({ action: "dismiss_flag", flag_key: k })} />}

      <section className={`${card} grid grid-cols-2 gap-3 sm:grid-cols-4`}>
        <Select name="pm-status" label="Status" value={v.status} onChange={set("status")} options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} error={errors.status} />
        <Select name="pm-intent" label="Intent" value={v.intent} onChange={set("intent")} options={Object.entries(INTENT_LABEL).map(([value, label]) => ({ value, label }))} />
        <Select name="pm-business" label="Business" value={v.business} onChange={set("business")} options={BUSINESS_OPTIONS} />
        <TextField name="pm-category" label="Category" value={category === "reel" ? "Reel" : "Picture post"} onChange={() => undefined} disabled />
        <Select name="pm-series" label="Series" value={v.series_id} onChange={set("series_id")} options={[{ value: "", label: "None" }, ...data.series.filter((s) => !s.archived_at || s.id === v.series_id).map((s) => ({ value: s.id, label: s.name }))]} />
        <TextField name="pm-position" label="Position in series" value={v.series_position} onChange={set("series_position")} inputMode="numeric" error={errors.series_position} />
        <div className="col-span-2 flex items-end"><Checkbox name="pm-recurring" label="Recurring (can be posted again)" checked={v.is_recurring} onChange={set("is_recurring")} /></div>
        <fieldset className="col-span-2 sm:col-span-4">
          <legend className="mb-1 text-xs font-medium">Platforms</legend>
          <div className="flex flex-wrap gap-3">{LIBRARY_PLATFORMS.map((p) => <label key={p} className={`flex items-center gap-2 text-sm ${touch}`}><input type="checkbox" checked={v.platforms.includes(p)} onChange={() => set("platforms")(toggle(v.platforms, p))} /> {PLATFORM_LABEL[p]}</label>)}</div>
        </fieldset>
        <fieldset className="col-span-2 sm:col-span-4">
          <legend className="mb-1 text-xs font-medium">Products mentioned</legend>
          <div className="flex flex-wrap gap-3">{PRODUCT_KEYS.map((p) => <label key={p} className={`flex items-center gap-2 text-sm ${touch}`}><input type="checkbox" checked={v.products_mentioned.includes(p)} onChange={() => set("products_mentioned")(toggle(v.products_mentioned, p))} /> {PRODUCT_KEY_LABEL[p]}</label>)}</div>
        </fieldset>
      </section>

      {category === "reel" ? (
        <section className={`${card} space-y-3`}>
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Reel</h3><CopyButton text={scriptText} labelText="Copy script" /></div>
          <TextField name="pm-hook" label={`Hook (${v.hook.length}/300)`} value={v.hook} onChange={set("hook")} error={errors.hook} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TextField name="pm-style" label="Style" value={v.style_tag} onChange={set("style_tag")} placeholder="e.g. Explainer" />
            <TextField name="pm-duration" label="Duration" value={v.duration_text} onChange={set("duration_text")} placeholder="0:20–0:35" hint={(() => { const d = parseDuration(v.duration_text); return v.duration_text ? (d ? `${d.min} to ${d.max} seconds` : "Use m:ss–m:ss") : undefined; })()} />
            <TextField name="pm-cta" label="Call to action (CTA)" value={v.cta_text} onChange={set("cta_text")} error={errors.cta_text} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">Script beats ({v.script_beats.length}/20)</p>
            {errors.script_beats && <p className={errorBox}>{errors.script_beats}</p>}
            <ol className="space-y-2" data-testid="script-beats">
              {v.script_beats.map((b, i) => (
                <li
                  key={b.k}
                  draggable
                  onDragStart={() => setDragFrom(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (dragFrom !== null) moveBeat(dragFrom, i); setDragFrom(null); }}
                  className="flex items-start gap-2 rounded-md border border-zinc-200 p-2"
                  data-testid="script-beat"
                >
                  <span className="cursor-grab select-none pt-2 text-sm" aria-hidden>⋮⋮</span>
                  <input aria-label={`Beat ${i + 1} time`} value={b.time} onChange={(e) => set("script_beats")(v.script_beats.map((x) => (x.k === b.k ? { ...x, time: e.target.value } : x)))} className={`${input} w-20`} placeholder="0:00" />
                  <textarea aria-label={`Beat ${i + 1}`} value={b.beat} rows={2} onChange={(e) => set("script_beats")(v.script_beats.map((x) => (x.k === b.k ? { ...x, beat: e.target.value } : x)))} className={`${input} flex-1`} />
                  <div className="flex flex-col gap-1">
                    <button type="button" className={btn} onClick={() => moveBeat(i, i - 1)} disabled={i === 0} aria-label={`Move beat ${i + 1} up`}>↑</button>
                    <button type="button" className={btn} onClick={() => moveBeat(i, i + 1)} disabled={i === v.script_beats.length - 1} aria-label={`Move beat ${i + 1} down`}>↓</button>
                    <button type="button" className={btn} onClick={() => set("script_beats")(v.script_beats.filter((x) => x.k !== b.k))} aria-label={`Remove beat ${i + 1}`}>✕</button>
                  </div>
                </li>
              ))}
            </ol>
            <button type="button" className={`${btn} mt-2 ${touch}`} disabled={v.script_beats.length >= 20} onClick={() => set("script_beats")([...v.script_beats, { time: "", beat: "", k: ++beatKey }])}>Add beat</button>
          </div>
          <TextArea name="pm-visual" label="Visual direction" value={v.visual_direction} onChange={set("visual_direction")} rows={3} />
          <TextArea name="pm-why" label="Why it converts" value={v.why_it_converts} onChange={set("why_it_converts")} rows={3} />
          <TextArea name="pm-caption" label={`Caption (optional, ${v.caption.length}/4000)`} value={v.caption} onChange={set("caption")} rows={3} hint="Only use claims from the approved list." />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField name="pm-window" label="Best window" value={v.best_window_text} onChange={set("best_window_text")} />
            <TextField name="pm-window-why" label="Why this window" value={v.best_window_why} onChange={set("best_window_why")} />
          </div>
        </section>
      ) : (
        <section className={`${card} space-y-3`}>
          <h3 className="text-sm font-semibold">Picture post</h3>
          <Select name="pm-format" label="Format" value={v.picture_format} onChange={set("picture_format")} options={Object.entries(FORMAT_LABEL).map(([value, label]) => ({ value, label }))} />
          <TextField name="pm-hook" label={`Hook (${v.hook.length}/300)`} value={v.hook} onChange={set("hook")} />
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="f-pm-caption" className="text-xs font-medium">Caption ({v.caption.length}/4000)</label>
              <button type="button" className={btn} onClick={() => setClosingOpen(true)}>Insert closing line</button>
            </div>
            <textarea id="f-pm-caption" rows={8} value={v.caption} onChange={(e) => set("caption")(e.target.value)} className={input} aria-invalid={!!errors.caption} />
            <p className="mt-1 text-[11px]">Only use claims from the approved list.</p>
          </div>
          <TextField name="pm-hashtags" label="Hashtags" value={v.hashtags} onChange={set("hashtags")} placeholder={series?.default_hashtags ?? ""} hint={series?.default_hashtags ? "Leave blank to use the series hashtags." : undefined} />
          <TextArea name="pm-visual-notes" label="Visual notes" value={v.visual_notes} onChange={set("visual_notes")} rows={2} />
        </section>
      )}

      {(hits.avoid.length > 0 || hits.risky.length > 0) && (
        <section className={warnBox} data-testid="editor-hits">
          <p className="font-medium">Words to review (these never block saving, only Ready):</p>
          {hits.avoid.length > 0 && <p><Chip tone="red">Avoid list</Chip> {hits.avoid.map((h) => `“${h.phrase}”`).join(", ")}</p>}
          {hits.risky.length > 0 && <p><Chip tone="amber">Watch words</Chip> {hits.risky.map((h) => `“${h.phrase}”`).join(", ")}</p>}
          <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-200 bg-white p-2 text-xs">
            <Highlighted text={[v.hook, v.caption, ...v.script_beats.map((b) => b.beat)].filter(Boolean).join("\n\n")} hits={hits} />
          </div>
        </section>
      )}

      <section className={`${card} space-y-3`}>
        <h3 className="text-sm font-semibold">Claims used</h3>
        <ClaimsPicker data={data} selected={v.claim_ids} onChange={set("claim_ids")} />
      </section>

      <NeedsSection data={data} item={item} reload={reload} />

      <section className={`${card} space-y-3`}>
        <h3 className="text-sm font-semibold">Sign-offs</h3>
        <Checkbox name="pm-permission-needed" label="Uses customer content (needs their permission)" checked={v.needs_customer_permission} onChange={set("needs_customer_permission")} />
        {item && item.needs_customer_permission && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {item.permission_confirmed_at ? (
              <>
                <span>Customer permission confirmed by {item.permission_confirmed_by_name} on {fmtDate(item.permission_confirmed_at.slice(0, 10))}.</span>
                <button type="button" className={btn} onClick={() => action({ action: "clear_permission" })}>Undo</button>
              </>
            ) : (
              <button type="button" className={`${btn} ${touch}`} onClick={() => action({ action: "confirm_permission" })}>Customer permission confirmed</button>
            )}
          </div>
        )}
        {(hits.avoid.length > 0 || hits.risky.length > 0) && item && (
          <label className={`flex items-center gap-2 text-sm ${touch}`}>
            <input
              type="checkbox"
              checked={item.risky_ack_hash === hash}
              disabled={dirty || item.risky_ack_hash === hash}
              onChange={() => action({ action: "ack_words", hash })}
            />
            Words reviewed{item.risky_ack_hash === hash && item.risky_ack_by_name ? ` (by ${item.risky_ack_by_name})` : ""}
            {dirty && <span className="text-xs">Save your changes first.</span>}
          </label>
        )}
      </section>

      <TextArea name="pm-notes" label="Notes" value={v.notes} onChange={set("notes")} rows={3} />

      {v.status === "ready" && blockers.length > 0 && (
        <div className={errorBox} role="alert" data-testid="library-ready-blockers">
          <p className="font-medium">Before this can be Ready:</p>
          <ul className="list-disc pl-4">{blockers.map((b) => <li key={b.key}>{b.message}</li>)}</ul>
        </div>
      )}
      {closingOpen && <ClosingLinePicker data={data} onClose={() => setClosingOpen(false)} onPick={(t) => { set("caption")(v.caption.trimEnd() ? `${v.caption.trimEnd()}\n\n${t}` : t); setClosingOpen(false); }} />}
    </Drawer>
  );
}

function FlagsSection({ flags, onDismiss }: { flags: PremadeRow["flags"]; onDismiss: (k: FlagKey) => void }) {
  const open = flags.filter((f) => !f.dismissed_at);
  const done = flags.filter((f) => f.dismissed_at);
  return (
    <section className={`${card} space-y-2`} data-testid="flags-section">
      <h3 className="text-sm font-semibold">Flags</h3>
      {open.length === 0 && <p className="text-xs">No open flags.</p>}
      {open.map((f) => (
        <div key={f.id} className="rounded-md border border-sky-200 bg-sky-50 p-2 text-xs">
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">{FLAG_LABEL[f.flag_key]}</p>
            <button type="button" className={btn} onClick={() => onDismiss(f.flag_key)}>Dismiss</button>
          </div>
          <FlagDetail detail={f.detail} />
        </div>
      ))}
      {done.length > 0 && (
        <p className="text-[11px]">Dismissed: {done.map((f) => `${FLAG_LABEL[f.flag_key]} (${f.dismissed_by_name}, ${fmtDate(f.dismissed_at!.slice(0, 10))})`).join("; ")}</p>
      )}
    </section>
  );
}

function FlagDetail({ detail }: { detail: Record<string, unknown> }) {
  const changes = Array.isArray(detail.changes) ? (detail.changes as Array<{ before?: string; after?: string; context?: string; field?: string }>) : null;
  if (changes) {
    return (
      <ul className="mt-1 space-y-1">
        {changes.map((c, i) => (
          <li key={i}>
            {c.field ? <span className="font-medium">{c.field}: </span> : null}“{c.before}” → “{c.after}”{c.context ? <div className="pl-3">{c.context}</div> : null}
          </li>
        ))}
      </ul>
    );
  }
  const text = typeof detail.message === "string" ? detail.message : Object.entries(detail).filter(([k]) => k !== "dismiss_note").map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ");
  return text ? <p className="mt-1">{text}</p> : null;
}

export function ClaimsPicker({ data, selected, onChange }: { data: MarketingData; selected: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const list = data.claims.filter((c) => (c.status !== "retired" || selected.includes(c.id)) && (!q || c.claim_text.toLowerCase().includes(q.toLowerCase())));
  const tone: Record<string, "green" | "blue" | "zinc" | "red"> = { approved: "green", in_review: "blue", draft: "zinc", rejected: "red", retired: "zinc" };
  return (
    <div className="space-y-2">
      <input aria-label="Search claims" placeholder="Search claims" value={q} onChange={(e) => setQ(e.target.value)} className={input} />
      <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-zinc-200 p-1" data-testid="claims-picker">
        {list.length === 0 && <li className="p-2 text-xs">No claims.</li>}
        {list.map((c) => (
          <li key={c.id}>
            <label className={`flex items-center gap-2 text-xs ${touch}`}>
              <input type="checkbox" checked={selected.includes(c.id)} onChange={() => onChange(selected.includes(c.id) ? selected.filter((x) => x !== c.id) : [...selected, c.id])} />
              <span className="flex-1">{c.claim_text}</span>
              <Chip tone={tone[c.status] ?? "zinc"}>{c.status.replace("_", " ")}</Chip>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClosingLinePicker({ data, onClose, onPick }: { data: MarketingData; onClose: () => void; onPick: (text: string) => void }) {
  const [q, setQ] = useState("");
  const list = data.closingLines.filter((c) => !c.archived_at && (!q || c.text.toLowerCase().includes(q.toLowerCase())));
  return (
    <Dialog title="Insert a closing line" onClose={onClose} wide>
      <div className="space-y-2 text-black">
        <input aria-label="Search closing lines" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className={input} autoFocus />
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {list.length === 0 && <li className="text-xs">No closing lines. Add them on the Templates tab.</li>}
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" className={`w-full rounded-md border border-zinc-200 p-2 text-left text-sm hover:bg-zinc-50 ${touch}`} onClick={() => onPick(c.text)}>
                {c.text}
                {c.used_with_note && <span className="ml-2 text-[11px]">({c.used_with_note})</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

// --- Templates tab: closing lines ---------------------------------------------------------------------
export function ClosingLinesSection({ data, reload }: TabProps) {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; text: string; used_with_note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = data.closingLines.filter((c) => !!c.archived_at === showArchived && (!q || c.text.toLowerCase().includes(q.toLowerCase())));
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
    <section className="space-y-3" data-testid="closing-lines">
      <h2 className="text-sm font-semibold">Closing lines</h2>
      {error && <p className={errorBox} role="alert">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <input aria-label="Search closing lines" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className={`${input} w-56`} />
          <Checkbox name="cl-archived" label="Show archived" checked={showArchived} onChange={setShowArchived} />
        </div>
        <button type="button" className={btnPrimary} onClick={() => setEditing({ id: null, text: "", used_with_note: "" })}>Add closing line</button>
      </div>
      <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white">
        {rows.length === 0 && <li className="p-3 text-xs">No closing lines.</li>}
        {rows.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span>{c.text}{c.used_with_note && <span className="ml-2 text-xs">Used with: {c.used_with_note}</span>}</span>
            <span className="flex gap-1">
              {!c.archived_at && <button type="button" className={btn} onClick={() => setEditing({ id: c.id, text: c.text, used_with_note: c.used_with_note ?? "" })}>Edit</button>}
              <CopyButton text={c.text} />
              <button type="button" className={btn} onClick={() => run(() => saveClosingLineApi(c.id, c.archived_at ? { restore: true } : { archive: true }))}>{c.archived_at ? "Restore" : "Archive"}</button>
            </span>
          </li>
        ))}
      </ul>
      {editing && (
        <Dialog title={editing.id ? "Edit closing line" : "New closing line"} onClose={() => setEditing(null)}>
          <div className="space-y-3 text-black">
            <TextArea name="cl-text" label={`Closing line (${editing.text.length}/300)`} value={editing.text} onChange={(x) => setEditing({ ...editing, text: x })} rows={3} />
            <TextField name="cl-note" label="Used with (optional)" value={editing.used_with_note} onChange={(x) => setEditing({ ...editing, used_with_note: x })} />
            <div className="flex justify-end gap-2">
              <button type="button" className={btn} onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className={btnPrimary} onClick={async () => { if (await run(() => saveClosingLineApi(editing.id, { text: editing.text, used_with_note: editing.used_with_note }))) setEditing(null); }}>Save</button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

