"use client";

/**
 * Marketing Hub › Ad Library and Pillars tabs: topics with their subtopics
 * (letters, hashtags), the library table (topic and subtopic filters, the
 * caption column, Copy captions, Edit caption, bulk Set topic), the post
 * form (a drawer on top of the tab, assets and needs before the first save),
 * and the Closing lines section of the Templates tab. Filters live in the
 * page address (lib_*, pil_*), so they survive a refresh and can be shared.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  createPillarApi,
  createPremadeApi,
  needsActionApi,
  premadeActionApi,
  premadeBulkApi,
  reletterApi,
  saveClosingLineApi,
  saveSeriesApi,
  updatePillarApi,
  updatePremadeApi,
  type GrowthApiError,
  type MarketingData,
} from "@/lib/growth/client";
import { FLAG_KEYS, FLAG_LABEL, nextFreeCode, reletterAlphabetically, type AssetNeed, type FlagKey, type Hits, type ReletterPlan } from "@/lib/growth/adLibrary";
import { parseDuration } from "@/lib/growth/playbookParse";
import { LETTERS, captionSnippet, captionView, composeFinalCaption, nextSubtopicLetter, normalizeHashtagList, parseHashtags, postName, previewMove, tagsNotIn } from "@/lib/growth/naming";
import { ATTENTION_KEYS, attentionMatch, copyList, filtersFromParams, libraryFilter, libraryList, libraryMatches, type AttentionKey, type LibraryFilters } from "@/lib/growth/libraryFilter";
import { gateView, tagsForPost, toLibRows, type LibRow } from "@/lib/growth/libraryView";
import type { Pillar, PremadeRow, Series } from "@/lib/growth/libraryService";
import { Badge, Checkbox, Chip, ConfirmDialog, Dialog, ErrorSummary, Select, TextArea, TextField, btn, btnPrimary, card, errorBox, fmtDate, infoBox, input, warnBox } from "./GrowthUi";
import { useUrlParams } from "./useUrlParams";
import { CopyButton } from "./MarketingTabs";
import { NeedsSection, NeedsPanel } from "./LibraryNeeds";
import { ScheduleDialog } from "./LibraryCalendar";
import { AssetCardPicker, AssetCards } from "./AssetCardPicker";
import { CaptionEditDialog, CopyCaptionsButton, HashtagField, MenuButton, Popover, useToast } from "./LibraryCaptions";

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

// --- Pillars tab (topics and their subtopics) -------------------------------------------------------------
const reletterItems = (data: MarketingData) => {
  const code = new Map(data.series.map((s) => [s.id, s.code]));
  return data.premades.map((p) => ({ id: p.id, pillar_id: p.pillar_id, title: p.title, post_number: p.post_number, subtopicCode: p.series_id ? code.get(p.series_id) ?? null : null, archived_at: p.archived_at }));
};
const libraryHref = (q: Record<string, string>) => `/growth/marketing?${new URLSearchParams({ tab: "library", ...q }).toString()}`;

export function PillarsTab({ data, reload }: TabProps) {
  const url = useUrlParams();
  const showArchived = url.get("pil_archived") === "1";
  const openSub = url.get("pil_sub");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [editing, setEditing] = useState<Pillar | "new" | null>(null);
  const [archiving, setArchiving] = useState<Pillar | null>(null);
  const [addingTo, setAddingTo] = useState<Pillar | null>(null);
  const [archivingSub, setArchivingSub] = useState<Series | null>(null);
  const [plan, setPlan] = useState<ReletterPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = data.pillars.filter((p) => showArchived || !p.archived_at);
  const livePosts = data.premades.filter((p) => !p.archived_at);
  const postCount = (pillarId: string) => livePosts.filter((p) => p.pillar_id === pillarId).length;
  const subPostCount = (subId: string) => livePosts.filter((p) => p.series_id === subId).length;
  const subsOf = (pillarId: string) => data.series.filter((s) => s.pillar_id === pillarId && (showArchived || !s.archived_at));
  const lastScheduled = (id: string) => {
    const ids = new Set(data.premades.filter((p) => p.pillar_id === id).map((p) => p.id));
    return data.posts.filter((p) => !p.archived_at && p.premade_post_id && ids.has(p.premade_post_id) && p.scheduled_date).map((p) => p.scheduled_date!).sort().pop() ?? null;
  };
  const toggle = (id: string) => setExpanded((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const preview = async () => {
    setError(null);
    try {
      setPlan((await reletterApi(false)).plan);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const sub = data.series.find((s) => s.id === openSub) ?? null;
  return (
    <section className="space-y-3">
      <p className={infoBox}>
        Each topic has a letter and each subtopic gets the next free letter inside its topic. Posts are named topic letter, subtopic letter, then a number: AA-1, AA-2, or B-1 for a post with no subtopic yet.
      </p>
      {error && <p className={errorBox} role="alert">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Checkbox name="pil-archived" label="Show archived" checked={showArchived} onChange={(v) => url.set({ pil_archived: v ? "1" : null })} />
        <div className="flex gap-2">
          <button type="button" className={btn} onClick={preview}>Re-letter alphabetically</button>
          <button type="button" className={btnPrimary} onClick={() => setEditing("new")} disabled={!nextFreeCode(data.pillars)}>Add topic</button>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">No topics yet. Add one to start the Ad Library.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full text-left text-xs" data-testid="pillars-table">
            <thead className="bg-zinc-50">
              <tr>
                <th className="w-8 px-2 py-2"><span className="sr-only">Expand</span></th>
                {["Letter", "Name", "Description", "Subtopics", "Posts", "Last scheduled", ""].map((h) => <th key={h || "a"} className="px-3 py-2 font-semibold">{h || <span className="sr-only">Actions</span>}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const open = expanded.includes(p.id);
                const subs = subsOf(p.id);
                return (
                  <Fragment key={p.id}>
                    <tr className="border-t border-zinc-100 align-top" data-testid="pillar-row">
                      <td className="px-2 py-2">
                        <button type="button" className={`${btn} px-2`} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} subtopics of ${p.code}`} onClick={() => toggle(p.id)}>{open ? "▾" : "▸"}</button>
                      </td>
                      <td className="px-3 py-2 text-base font-semibold">{p.code}</td>
                      <td className="px-3 py-2 font-medium">{p.name}{p.archived_at && <div><Badge>Archived</Badge></div>}</td>
                      <td className="max-w-md px-3 py-2">{p.description ?? "—"}</td>
                      <td className="px-3 py-2">{subs.filter((s) => !s.archived_at).length}</td>
                      <td className="px-3 py-2">{postCount(p.id)}</td>
                      <td className="px-3 py-2">{fmtDate(lastScheduled(p.id))}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        {p.archived_at ? (
                          <button type="button" className={btn} onClick={() => run(() => updatePillarApi(p.id, { restore: true }))}>Restore</button>
                        ) : (
                          <MenuButton label="Actions" ariaLabel={`Actions for topic ${p.code}`} items={[{ label: "Edit", onSelect: () => setEditing(p) }, { label: "Archive", onSelect: () => setArchiving(p) }]} />
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-zinc-50" data-testid="subtopic-subtable">
                        <td />
                        <td colSpan={7} className="px-3 py-2">
                          {subs.length === 0 ? (
                            <p className="text-xs">No subtopics yet.</p>
                          ) : (
                            <table className="min-w-full rounded border border-zinc-200 bg-white text-left text-xs">
                              <thead><tr>{["Code", "Subtopic name", "Posts", ""].map((h) => <th key={h || "a"} className="px-3 py-1.5 font-semibold">{h || <span className="sr-only">Actions</span>}</th>)}</tr></thead>
                              <tbody>
                                {subs.map((s) => (
                                  <tr key={s.id} className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50" onClick={() => url.set({ pil_sub: s.id })} data-testid="subtopic-row">
                                    <td className="px-3 py-1.5 font-semibold">{p.code}{s.code ?? "?"}</td>
                                    <td className="px-3 py-1.5">{s.name}{s.archived_at && <> <Badge>Archived</Badge></>}</td>
                                    <td className="px-3 py-1.5">{subPostCount(s.id)}</td>
                                    <td className="whitespace-nowrap px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                                      <div className="flex justify-end gap-1">
                                        <button type="button" className={btn} onClick={() => url.set({ pil_sub: s.id })}>Open</button>
                                        {s.archived_at ? (
                                          <button type="button" className={btn} onClick={() => run(() => saveSeriesApi(s.id, { restore: true }))}>Restore</button>
                                        ) : (
                                          <button type="button" className={btn} onClick={() => setArchivingSub(s)}>Archive</button>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          {!p.archived_at && <button type="button" className={`${btn} mt-2`} onClick={() => setAddingTo(p)}>Add subtopic</button>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <PillarDialog data={data} pillar={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
      {archiving && <ArchivePillarDialog data={data} pillar={archiving} onClose={() => setArchiving(null)} onDone={() => { setArchiving(null); void reload(); }} />}
      {addingTo && <AddSubtopicDialog data={data} pillar={addingTo} onClose={() => setAddingTo(null)} onDone={async () => { setExpanded((s) => [...new Set([...s, addingTo.id])]); setAddingTo(null); await reload(); }} />}
      {archivingSub && (
        <ConfirmDialog
          title={`Archive subtopic ${data.pillars.find((p) => p.id === archivingSub.pillar_id)?.code ?? ""}${archivingSub.code ?? ""}?`}
          confirmLabel="Archive"
          busy={busy}
          error={error}
          onClose={() => { setArchivingSub(null); setError(null); }}
          onConfirm={async () => {
            setBusy(true);
            setError(null);
            try {
              await saveSeriesApi(archivingSub.id, { archive: true });
              setArchivingSub(null);
              await reload();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {subPostCount(archivingSub.id) > 0 ? (
            <p className={warnBox}>{subPostCount(archivingSub.id)} post{subPostCount(archivingSub.id) === 1 ? " uses" : "s use"} this subtopic, so it can&apos;t be archived. Move them to another subtopic first (Ad Library, Set topic).</p>
          ) : (
            <p>Its letter stays reserved, so no future subtopic in this topic gets the same letter.</p>
          )}
        </ConfirmDialog>
      )}
      {sub && <SubtopicPanel key={sub.id} data={data} sub={sub} onClose={() => url.set({ pil_sub: null })} reload={reload} />}
      {plan && (
        <ConfirmDialog
          title="Re-letter alphabetically"
          confirmLabel={plan.changes.length && !plan.duplicates.length ? "Apply new letters" : "Close"}
          busy={busy}
          error={error}
          onConfirm={async () => {
            if (!plan.changes.length || plan.duplicates.length) return setPlan(null);
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
              {plan.duplicates.length > 0 && <p className={errorBox} role="alert">This would create duplicate names ({plan.duplicates.join(", ")}), so nothing can change.</p>}
              <p className="font-medium">{plan.affectedItems.length} post{plan.affectedItems.length === 1 ? "" : "s"} will get a new name:</p>
              <ul className="max-h-40 overflow-y-auto text-xs">{plan.affectedItems.map((i) => <li key={i.id}>{i.before} → {i.after}</li>)}</ul>
              <p className="text-xs">Calendar entries that aren&apos;t Posted show the new names. Posted entries keep theirs.</p>
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
  const letters = LETTERS.filter((c) => !used.has(c));
  const plan = pillar && v.code !== pillar.code ? reletterAlphabetically(data.pillars, reletterItems(data), { [pillar.id]: v.code }) : null;
  const renames = !!plan && plan.affectedItems.length > 0;
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
    <Dialog title={pillar ? `Edit topic ${pillar.code}` : "New topic"} onClose={onClose}>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <Select name="pillar-code" label="Letter" value={v.code} onChange={(x) => setV({ ...v, code: x })} options={letters.map((c) => ({ value: c, label: c }))} error={errors.code} />
        <TextField name="pillar-name" label="Name" value={v.name} onChange={(x) => setV({ ...v, name: x })} required error={errors.name} />
        <TextArea name="pillar-description" label={`Description (${v.description.length}/500)`} value={v.description} onChange={(x) => setV({ ...v, description: x })} rows={3} error={errors.description} />
        <Checkbox name="pillar-recurring" label="Recurring" checked={v.recurring} onChange={(x) => setV({ ...v, recurring: x })} />
        {plan && plan.duplicates.length > 0 && <p className={errorBox} role="alert">That letter would give duplicate names: {plan.duplicates.join(", ")}.</p>}
        {confirming && plan && (
          <div className={warnBox} data-testid="rename-preview">
            <p className="font-medium">{plan.affectedItems.length} post{plan.affectedItems.length === 1 ? "" : "s"} will get a new name.</p>
            <ul className="mt-1 max-h-40 overflow-y-auto">{plan.affectedItems.map((p) => <li key={p.id}>{p.before} → {p.after}</li>)}</ul>
            <p className="mt-1">Calendar entries that aren&apos;t Posted show the new names. Posted entries keep theirs.</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          {renames && !confirming ? (
            <button type="button" className={btnPrimary} onClick={() => setConfirming(true)} disabled={!!plan?.duplicates.length}>Save</button>
          ) : (
            <button type="button" className={btnPrimary} onClick={save} disabled={!!plan?.duplicates.length}>{confirming ? "Confirm and save" : "Save"}</button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ArchivePillarDialog({ data, pillar, onClose, onDone }: { data: MarketingData; pillar: Pillar; onClose: () => void; onDone: () => void }) {
  const posts = data.premades.filter((p) => p.pillar_id === pillar.id && !p.archived_at).length;
  const subs = data.series.filter((s) => s.pillar_id === pillar.id && !s.archived_at).length;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = posts > 0 || subs > 0;
  return (
    <ConfirmDialog
      title={`Archive ${pillar.code} · ${pillar.name}?`}
      confirmLabel={blocked ? "Close" : "Archive"}
      busy={busy}
      error={error}
      onConfirm={async () => {
        if (blocked) return onClose();
        setBusy(true);
        setError(null);
        try {
          await updatePillarApi(pillar.id, { archive: true });
          onDone();
        } catch (e) {
          setError((e as Error).message);
          setBusy(false);
        }
      }}
      onClose={onClose}
    >
      {blocked ? (
        <p className={warnBox}>
          This topic still has {[posts ? `${posts} post${posts === 1 ? "" : "s"}` : "", subs ? `${subs} subtopic${subs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}. Move or archive them first.
        </p>
      ) : (
        <p>Archived topics stay on existing calendar entries; they just can&apos;t be chosen for new posts.</p>
      )}
    </ConfirmDialog>
  );
}

function AddSubtopicDialog({ data, pillar, onClose, onDone }: { data: MarketingData; pillar: Pillar; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  let letter: string | null = null;
  try {
    letter = nextSubtopicLetter(data.series.filter((s) => s.pillar_id === pillar.id).map((s) => s.code));
  } catch {
    letter = null;
  }
  return (
    <Dialog title={`Add a subtopic to ${pillar.code} · ${pillar.name}`} onClose={onClose}>
      <div className="space-y-3 text-black">
        {error && <p className={errorBox} role="alert">{error}</p>}
        <TextField name="sub-name" label="Subtopic name" value={name} onChange={setName} required />
        <p className="text-xs">{letter ? `Will be created as subtopic ${pillar.code}${letter}.` : "This topic already uses all 26 subtopic letters."}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={btnPrimary}
            disabled={!name.trim() || !letter || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await saveSeriesApi(null, { pillar_id: pillar.id, name: name.trim() });
                onDone();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            {busy ? "Adding…" : "Add subtopic"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** A subtopic: name, code (read-only), hashtags, notes, cover text, and its posts. */
function SubtopicPanel({ data, sub, onClose, reload }: { data: MarketingData; sub: Series; onClose: () => void; reload: () => Promise<void> }) {
  const pillar = data.pillars.find((p) => p.id === sub.pillar_id);
  const [v, setV] = useState({ name: sub.name, default_hashtags: sub.default_hashtags ?? "", notes: sub.notes ?? "", cover_text: sub.cover_text ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const posts = data.premades.filter((p) => p.series_id === sub.id && !p.archived_at).sort((a, b) => (a.post_number ?? 0) - (b.post_number ?? 0) || a.name.localeCompare(b.name));
  const save = async () => {
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      await saveSeriesApi(sub.id, v);
      await reload();
      setV((s) => ({ ...s, default_hashtags: normalizeHashtagList(s.default_hashtags) ?? "" }));
      setSaved(true);
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={`Subtopic ${pillar?.code ?? ""}${sub.code ?? "?"} · ${sub.name}`}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          {saved && <span className="self-center text-sm" role="status">Saved.</span>}
          <button type="button" className={`${btn} ${touch}`} onClick={onClose}>Close</button>
          <button type="button" className={`${btnPrimary} ${touch}`} onClick={save} disabled={busy || !!sub.archived_at}>{busy ? "Saving…" : "Save"}</button>
        </div>
      }
    >
      <ErrorSummary message={message} errors={errors} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2"><TextField name="sub-panel-name" label="Name" value={v.name} onChange={(x) => { setSaved(false); setV({ ...v, name: x }); }} required error={errors.name} /></div>
        <TextField name="sub-panel-code" label="Code" value={`${pillar?.code ?? ""}${sub.code ?? "?"}`} onChange={() => undefined} disabled />
      </div>
      <HashtagField name="sub-hashtags" value={v.default_hashtags} onChange={(x) => { setSaved(false); setV({ ...v, default_hashtags: x }); }} error={errors.default_hashtags} />
      <TextArea name="sub-notes" label="Notes" value={v.notes} onChange={(x) => { setSaved(false); setV({ ...v, notes: x }); }} rows={3} error={errors.notes} />
      <TextField name="sub-cover" label="Cover text" value={v.cover_text} onChange={(x) => { setSaved(false); setV({ ...v, cover_text: x }); }} error={errors.cover_text} />
      <section className={`${card} space-y-1`}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Posts in this subtopic ({posts.length})</h3>
          <Link className="text-xs underline" href={libraryHref({ lib_topic: sub.pillar_id, lib_sub: sub.id })}>Open in the Ad Library</Link>
        </div>
        {posts.length === 0 ? (
          <p className="text-xs">No posts yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2 text-sm" data-testid="subtopic-posts">
            {posts.map((p) => (
              <li key={p.id}><Link className="font-medium underline" href={libraryHref({ lib_topic: sub.pillar_id, lib_sub: sub.id, lib_cat: p.category, item: p.id })}>{p.name}</Link></li>
            ))}
          </ul>
        )}
      </section>
    </Drawer>
  );
}

// --- Ad Library tab -----------------------------------------------------------------------------------
const FILTER_KEY: Record<keyof LibraryFilters, string> = {
  cat: "lib_cat",
  topic: "lib_topic",
  subtopic: "lib_sub",
  status: "lib_status",
  intent: "lib_intent",
  product: "lib_product",
  att: "lib_att",
  flag: "lib_flag",
  q: "lib_q",
  paused: "lib_paused",
  sort: "lib_sort",
};
const ATTENTION_LABEL: Record<AttentionKey, string> = {
  needs: "Needs assets",
  permission: "Needs customer permission",
  avoid: "Matches avoid list",
  watch: "Matches watch words",
  flag: "Has an open flag",
  nosub: "No subtopic",
  dupe: "Duplicate names",
  unscheduled: "Not yet scheduled",
};
type Row = LibRow<PremadeRow>;

export function AdLibraryTab({ data, reload }: TabProps) {
  const url = useUrlParams();
  const f = filtersFromParams(url.get);
  const setF = (patch: Partial<LibraryFilters>) => {
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(patch) as Array<[keyof LibraryFilters, unknown]>) {
      const key = FILTER_KEY[k];
      if (k === "att") out[key] = (v as string[]).join(",") || null;
      else if (k === "paused") out[key] = v ? "1" : null;
      else if (k === "cat") out[key] = v === "picture_post" ? "picture_post" : null;
      else if (k === "sort") out[key] = v === "newest" ? "newest" : null;
      else out[key] = (v as string) || null;
    }
    url.set(out);
  };
  const openId = url.get("item");
  const [newCat, setNewCat] = useState<"reel" | "picture_post" | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [needsOpen, setNeedsOpen] = useState(url.get("lib_needs") === "1");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [editingCaption, setEditingCaption] = useState<PremadeRow | null>(null);
  const [archiving, setArchiving] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toastNode, toast] = useToast();
  const all = useMemo(() => toLibRows(data, data.premades), [data]);
  const rows = libraryList(all, f);
  const count = (cat: LibraryFilters["cat"]) => libraryFilter(all, { ...f, cat }).length;
  const attCount = (key: string) => all.filter((p) => libraryMatches(p, f, key) && attentionMatch(p, key, f.flag)).length;
  const activePillars = data.pillars.filter((p) => !p.archived_at);
  const pillarById = useMemo(() => new Map(data.pillars.map((p) => [p.id, p])), [data.pillars]);
  const subOptions = (f.topic ? data.series.filter((s) => s.pillar_id === f.topic) : data.series).filter((s) => !s.archived_at || s.id === f.subtopic);
  const subGroups = activePillars.map((p) => ({ p, subs: subOptions.filter((s) => s.pillar_id === p.id).sort((a, b) => (a.code ?? "~").localeCompare(b.code ?? "~")) })).filter((g) => g.subs.length);
  const moreCount = [f.status, f.intent, f.product].filter(Boolean).length + f.att.length + (f.sort === "newest" ? 1 : 0);
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
  const allExpanded = rows.length > 0 && rows.every((r) => expanded.includes(r.id));
  const rowKey = rows.map((r) => r.id).join(",");
  useEffect(() => {
    // Drop selections that are no longer listed (filter change or reload).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keep the selection in step with the filtered list
    setSelected((s) => s.filter((id) => rowKey.split(",").includes(id)));
  }, [rowKey]);
  const toggleExpand = (id: string) => setExpanded((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleAtt = (k: string) => setF({ att: f.att.includes(k) ? f.att.filter((x) => x !== k) : [...f.att, k] });
  const clearFilters = () => url.set(Object.fromEntries(Object.entries(FILTER_KEY).filter(([k]) => k !== "cat").map(([, v]) => [v, null])));

  if (activePillars.length === 0) {
    return <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">Add a topic on the Pillars tab first. Every library post belongs to a topic.</p>;
  }
  return (
    <section className="space-y-3">
      {error && <p className={errorBox} role="alert">{error}</p>}
      {data.duplicateNames.length > 0 && (
        <div className={`${errorBox} flex flex-wrap items-center justify-between gap-2`} role="alert" data-testid="duplicate-banner">
          <span>{data.duplicateNames.length} duplicate name{data.duplicateNames.length === 1 ? "" : "s"} found: {data.duplicateNames.map((d) => d.name).join(", ")}</span>
          <button type="button" className={btn} onClick={() => toggleAtt("dupe")}>{f.att.includes("dupe") ? "Show all posts" : "Show them"}</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => setNewCat("reel")}>New reel</button>
        <button type="button" className={`${btnPrimary} ${touch}`} onClick={() => setNewCat("picture_post")}>New picture post</button>
        <button type="button" className={`${btn} ${touch}`} onClick={() => { setNeedsOpen(true); url.set({ lib_needs: "1" }); }}>Needs</button>
        <div className="ml-auto">
          <CopyCaptionsButton rowsFor={(both) => copyList(all, f, both)} toast={toast} />
        </div>
      </div>
      <div className="flex gap-1 border-b border-zinc-200" role="tablist" aria-label="Library category">
        {(["reel", "picture_post"] as const).map((c) => (
          <button key={c} type="button" role="tab" aria-selected={f.cat === c} onClick={() => setF({ cat: c })} className={`border-b-2 px-3 py-2 text-sm font-medium ${f.cat === c ? "border-emerald-600" : "border-transparent"}`} data-testid={`lib-sub-${c}`}>
            {c === "reel" ? "Reels" : "Picture posts"} ({count(c)})
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <select
          aria-label="Topic"
          value={f.topic}
          onChange={(e) => {
            const topic = e.target.value;
            const keep = f.subtopic === "none" || (!!f.subtopic && data.series.find((s) => s.id === f.subtopic)?.pillar_id === topic);
            setF({ topic, subtopic: keep ? f.subtopic : "" });
          }}
          className={`${input} w-52`}
        >
          <option value="">All topics</option>
          {activePillars.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
        </select>
        <select aria-label="Subtopic" value={f.subtopic} onChange={(e) => setF({ subtopic: e.target.value })} className={`${input} w-56`}>
          <option value="">All subtopics</option>
          <option value="none">No subtopic yet</option>
          {f.topic
            ? subGroups.flatMap((g) => g.subs).map((s) => <option key={s.id} value={s.id}>{pillarById.get(s.pillar_id)?.code}{s.code ?? "?"} · {s.name}</option>)
            : subGroups.map((g) => (
                <optgroup key={g.p.id} label={`${g.p.code} · ${g.p.name}`}>
                  {g.subs.map((s) => <option key={s.id} value={s.id}>{g.p.code}{s.code ?? "?"} · {s.name}</option>)}
                </optgroup>
              ))}
        </select>
        <input aria-label="Search the library" placeholder="Search name, title or caption" value={f.q} onChange={(e) => setF({ q: e.target.value })} className={`${input} w-60`} />
        <Popover label={`More filters${moreCount ? ` (${moreCount})` : ""}`} ariaLabel="More filters" className={`${btn} ${touch}`} align="left">
          <div className="space-y-2 text-sm" data-testid="more-filters">
            <select aria-label="Status" value={f.status} onChange={(e) => setF({ status: e.target.value })} className={input}><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <select aria-label="Intent" value={f.intent} onChange={(e) => setF({ intent: e.target.value })} className={input}><option value="">Any intent</option>{Object.entries(INTENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <select aria-label="Product" value={f.product} onChange={(e) => setF({ product: e.target.value })} className={input}><option value="">Any product</option>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select aria-label="Sort" value={f.sort} onChange={(e) => setF({ sort: e.target.value as LibraryFilters["sort"] })} className={input}>
              <option value="name">Sort by name</option>
              <option value="newest">Newest first</option>
            </select>
            <fieldset className="space-y-1">
              <legend className="text-xs font-semibold">Needs attention</legend>
              {ATTENTION_KEYS.map((k) => (
                <label key={k} className="flex items-center gap-2">
                  <input type="checkbox" checked={f.att.includes(k)} onChange={() => toggleAtt(k)} /> {ATTENTION_LABEL[k]} ({attCount(k)})
                </label>
              ))}
              {f.att.includes("flag") && (
                <select aria-label="Flag type" value={f.flag} onChange={(e) => setF({ flag: e.target.value })} className={input}>
                  <option value="">Any open flag</option>
                  {FLAG_KEYS.map((k) => <option key={k} value={k}>{FLAG_LABEL[k]}</option>)}
                </select>
              )}
            </fieldset>
          </div>
        </Popover>
        <Checkbox name="lib-paused" label="Show paused" checked={f.paused} onChange={(v) => setF({ paused: v })} />
        <button type="button" className={`${btn} ${touch}`} onClick={clearFilters}>Clear filters</button>
      </div>

      {selected.length > 0 && (
        <div className={`${infoBox} flex flex-wrap items-center gap-2`} data-testid="bulk-bar">
          <span className="font-medium">{selected.length} selected</span>
          <button type="button" className={btn} onClick={() => setBulk("set_topic")}>Set topic</button>
          <button type="button" className={btn} onClick={() => setBulk("set_products")}>Set products</button>
          <button type="button" className={btn} onClick={() => act(() => premadeBulkApi({ ids: selected, action: "pause" }))}>Pause</button>
          <button type="button" className={btn} onClick={() => act(() => premadeBulkApi({ ids: selected, action: "reactivate" }))}>Reactivate</button>
          <button type="button" className={btn} onClick={() => setBulk("archive")}>Archive</button>
          <button type="button" className={btn} onClick={() => setBulk("dismiss_flag")}>Dismiss a flag</button>
          <button type="button" className={btn} onClick={() => setSelected([])}>Clear</button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm">{all.some((r) => !r.archived_at && r.category === f.cat) ? "Nothing matches these filters." : `No ${f.cat === "reel" ? "reels" : "picture posts"} yet.`}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full text-left text-xs" data-testid="library-table">
            <thead className="bg-zinc-50">
              <tr>
                <th className="px-2 py-2"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? [] : rows.map((r) => r.id))} /></th>
                <th className="sticky left-0 z-10 bg-zinc-50 px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Topic</th>
                <th className="min-w-[420px] px-3 py-2 font-semibold">
                  <span className="flex items-center justify-between gap-2">
                    Caption
                    <button type="button" className="font-normal underline" onClick={() => setExpanded(allExpanded ? [] : rows.map((r) => r.id))}>{allExpanded ? "Collapse all captions" : "Expand all captions"}</button>
                  </span>
                </th>
                {["Format", "Status", "Flags", "Scheduled", ""].map((h) => <th key={h || "a"} className="px-3 py-2 font-semibold">{h || <span className="sr-only">Actions</span>}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = r.post;
                const flags = p.flags.filter((x) => !x.dismissed_at);
                return (
                  <tr key={p.id} className="border-t border-zinc-100 align-top" data-testid="library-row">
                    <td className="px-2 py-2"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.includes(p.id)} onChange={() => setSelected((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))} /></td>
                    <td className="sticky left-0 z-10 max-w-[12rem] bg-white px-3 py-2">
                      <button type="button" className="text-left text-sm font-bold underline" onClick={() => url.set({ item: p.id })}>{r.name}</button>
                      {p.title && <div className="text-[11px]">{p.title}</div>}
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {p.post_number === null && <Chip tone="amber">Needs numbering</Chip>}
                        {r.duplicate && <Chip tone="red">Duplicate name</Chip>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div>{r.pillarCode} · {r.pillarName}</div>
                      {r.subtopicName ? <div>{r.pillarCode}{r.subtopicCode ?? "?"} · {r.subtopicName}</div> : <Chip tone="zinc">No subtopic yet</Chip>}
                    </td>
                    <td className="min-w-[420px] px-3 py-2">
                      <CaptionCell row={r} expanded={expanded.includes(p.id)} onToggle={() => toggleExpand(p.id)} onEdit={() => setEditingCaption(p)} />
                    </td>
                    <td className="px-3 py-2">{p.category === "picture_post" ? FORMAT_LABEL[p.picture_format ?? "unknown"] : fmtDuration(p)}</td>
                    <td className="px-3 py-2"><Chip tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Chip></td>
                    <td className="px-3 py-2">
                      <div className="flex max-w-xs flex-wrap gap-1" data-testid="row-flags">
                        {r.openNeeds > 0 && <Chip tone="amber">{r.openNeeds} asset{r.openNeeds === 1 ? "" : "s"} needed</Chip>}
                        {r.avoidHits > 0 && <Chip tone="red">Avoid list</Chip>}
                        {r.watchHits > 0 && <Chip tone="amber">Watch words</Chip>}
                        {r.needsPermission && <Chip tone="amber">Permission</Chip>}
                        {flags.map((x) => <Chip key={x.id} tone="blue">{FLAG_LABEL[x.flag_key]}</Chip>)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{p.next_scheduled ? `Next: ${fmtDate(p.next_scheduled)}` : p.last_posted ? `Posted: ${fmtDate(p.last_posted)}` : "Not scheduled"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <MenuButton
                        label="Actions"
                        ariaLabel={`Actions for ${r.name}`}
                        items={[
                          { label: "Open", onSelect: () => url.set({ item: p.id }) },
                          { label: "Add to calendar", onSelect: () => setScheduling(p.id), disabled: p.status === "paused", hint: p.status === "paused" ? "Paused: reactivate it first" : undefined },
                          { label: "Duplicate", onSelect: () => act(async () => { const c = await premadeActionApi(p.id, { action: "duplicate" }); toast(`Duplicated as ${c.name ?? "a new post"}`); }) },
                          { label: p.status === "paused" ? "Reactivate" : "Pause", onSelect: () => act(() => premadeActionApi(p.id, { action: p.status === "paused" ? "reactivate" : "pause" })) },
                          { label: "Archive", onSelect: () => setArchiving(r) },
                        ]}
                      />
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
          onSaved={async (id, message) => { setNewCat(null); await reload(); url.set({ item: id }); toast(message); }}
          onSchedule={(p) => setScheduling(p.id)}
          reload={reload}
        />
      )}
      {editingCaption && (
        <CaptionEditDialog
          data={data}
          post={editingCaption}
          onClose={() => setEditingCaption(null)}
          onSaved={async (message) => { setEditingCaption(null); await reload(); toast(message); }}
        />
      )}
      {archiving && (
        <ConfirmDialog
          title={`Archive ${archiving.name}?`}
          confirmLabel="Archive"
          onClose={() => setArchiving(null)}
          onConfirm={() => { const id = archiving.id; setArchiving(null); void act(() => premadeActionApi(id, { action: "archive" })); }}
        >
          <p>Archived posts leave the library and keep their number. Calendar entries made from them stay as they are.</p>
        </ConfirmDialog>
      )}
      {bulk && <BulkDialog data={data} action={bulk} ids={selected} onClose={() => setBulk(null)} onDone={(message) => { setBulk(null); setSelected([]); if (message) toast(message); void reload(); }} />}
      {scheduling && <ScheduleDialog data={data} premadeId={scheduling} onClose={() => setScheduling(null)} onDone={(message) => { setScheduling(null); toast(message); void reload(); }} />}
      {needsOpen && <NeedsPanel data={data} reload={reload} onClose={() => { setNeedsOpen(false); url.set({ lib_needs: null }); }} />}
      {toastNode}
    </section>
  );
}

/** The table's caption cell: the body only (never hashtags), 100 characters, "...more" to expand. */
export function CaptionCell({ row, expanded, onToggle, onEdit }: { row: { post: { caption: string | null; hook: string | null; category: string }; tags: readonly string[] }; expanded: boolean; onToggle: () => void; onEdit: () => void }) {
  const p = row.post;
  const view = captionView(p, row.tags);
  const snip = captionSnippet(view.body, 100);
  const editLink = <button type="button" className="ml-1 underline" onClick={onEdit}>Add caption</button>;
  if (view.hashtagsOnly) {
    return <p data-testid="caption-cell">Hashtags only <button type="button" className="ml-1 underline" onClick={onEdit}>Edit</button></p>;
  }
  if (!view.body) {
    if (p.category === "reel" && (p.hook ?? "").trim()) {
      return <p data-testid="caption-cell"><span className="font-medium">Hook:</span> {p.hook} {editLink}</p>;
    }
    return <p data-testid="caption-cell">No caption yet {editLink}</p>;
  }
  if (expanded || !snip.truncated) {
    return (
      <div data-testid="caption-cell">
        <p className="whitespace-pre-wrap break-words">{view.body}</p>
        {view.extraTagCount > 0 && <p className="mt-1 text-[11px] text-black">Hashtags added when posted: {view.extraTagCount}</p>}
        <div className="mt-1 flex gap-2">
          <button type="button" className={btn} onClick={onEdit}>Edit</button>
          {snip.truncated && <button type="button" className="underline" onClick={onToggle}>Show less</button>}
        </div>
      </div>
    );
  }
  return (
    <p data-testid="caption-cell">
      {snip.snippet}
      <button type="button" className="ml-1 underline" onClick={onToggle} aria-label="Show the whole caption">...more</button>
    </p>
  );
}

function BulkDialog({ data, action, ids, onClose, onDone }: { data: MarketingData; action: string; ids: string[]; onClose: () => void; onDone: (message?: string) => void }) {
  const activePillars = data.pillars.filter((p) => !p.archived_at);
  const [pillar, setPillar] = useState(activePillars[0]?.id ?? "");
  const [sub, setSub] = useState("");
  const [newName, setNewName] = useState("");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [flag, setFlag] = useState<FlagKey>("pillar_assigned");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titles: Record<string, string> = { set_topic: "Set topic", set_products: "Set products", dismiss_flag: "Dismiss a flag", archive: "Archive posts" };
  const posts = data.premades.filter((p) => ids.includes(p.id));
  let preview: ReturnType<typeof previewMove> | null = null;
  let previewError: string | null = null;
  if (action === "set_topic" && pillar) {
    try {
      preview = previewMove({ posts, pillars: data.pillars, subtopics: data.series, target: { pillarId: pillar, subtopicId: sub && sub !== "__new" ? sub : null, newSubtopicName: sub === "__new" ? newName || "new" : null } });
    } catch (e) {
      previewError = (e as Error).message;
    }
  }
  return (
    <ConfirmDialog
      title={`${titles[action]} (${ids.length} selected)`}
      confirmLabel={titles[action]}
      busy={busy}
      error={error ?? previewError}
      onConfirm={async () => {
        if (action === "set_topic" && sub === "__new" && !newName.trim()) return setError("Enter the new subtopic's name.");
        setBusy(true);
        setError(null);
        try {
          const r = await premadeBulkApi({ ids, action, pillar_id: pillar, subtopic_id: sub && sub !== "__new" ? sub : null, new_subtopic_name: sub === "__new" ? newName.trim() : null, product_ids: productIds, flag_key: flag, note });
          onDone(action === "set_topic" ? `Moved ${r.moved?.length ?? 0} post${r.moved?.length === 1 ? "" : "s"}` : undefined);
        } catch (e) {
          setError((e as Error).message);
          setBusy(false);
        }
      }}
      onClose={onClose}
    >
      {action === "set_topic" && (
        <div className="space-y-2">
          <Select name="bulk-pillar" label="Topic" value={pillar} onChange={(x) => { setPillar(x); setSub(""); }} options={activePillars.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
          <Select
            name="bulk-sub"
            label="Subtopic"
            value={sub}
            onChange={setSub}
            options={[
              { value: "", label: "None for now" },
              ...data.series.filter((s) => s.pillar_id === pillar && !s.archived_at).map((s) => ({ value: s.id, label: `${s.code ?? "?"} · ${s.name}` })),
              { value: "__new", label: "Create a new subtopic" },
            ]}
          />
          {sub === "__new" && <TextField name="bulk-new-sub" label="New subtopic name" value={newName} onChange={setNewName} required />}
          {preview && (
            <div data-testid="move-preview">
              {sub === "__new" && preview.subtopicCode && <p className="text-xs">Will be created as subtopic {data.pillars.find((p) => p.id === pillar)?.code}{preview.subtopicCode}.</p>}
              {preview.moves.length === 0 ? (
                <p className="text-xs">All selected posts are already there. Nothing changes.</p>
              ) : (
                <>
                  <p className="text-xs font-medium">New names:</p>
                  <ul className="max-h-48 overflow-y-auto text-xs">{preview.moves.map((m) => <li key={m.id}>{m.oldName} → {m.newName}</li>)}</ul>
                </>
              )}
              <p className="mt-1 text-[11px]">Calendar entries that aren&apos;t Posted show the new names.</p>
            </div>
          )}
        </div>
      )}
      {action === "set_products" && (
        <fieldset>
          <legend className="mb-1 text-xs">Replaces the products on the selected posts.</legend>
          <div className="flex flex-wrap gap-3">
            {data.products.map((p) => (
              <label key={p.id} className={`flex items-center gap-2 text-sm ${touch}`}>
                <input type="checkbox" checked={productIds.includes(p.id)} onChange={() => setProductIds((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))} /> {p.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {action === "dismiss_flag" && (
        <>
          <Select name="bulk-flag" label="Flag" value={flag} onChange={(x) => setFlag(x as FlagKey)} options={FLAG_KEYS.map((k) => ({ value: k, label: FLAG_LABEL[k] }))} />
          <TextField name="bulk-note" label="Note (required)" value={note} onChange={setNote} placeholder="Why these can be dismissed" />
        </>
      )}
      {action === "archive" && <p>Archived posts leave the library and keep their numbers. Calendar entries made from them stay as they are.</p>}
    </ConfirmDialog>
  );
}

// --- Editor --------------------------------------------------------------------------------------------
type Form = {
  pillar_id: string;
  /** "" = none for now, "__new" = create one, else a subtopic id. */
  series_id: string;
  new_subtopic_name: string;
  business: string;
  status: string;
  intent: string;
  picture_format: string;
  hook: string;
  caption: string;
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
  product_ids: string[];
  clear_title: boolean;
  clear_imported_tags: boolean;
  clear_extra_hashtags: boolean;
};
let beatKey = 0;
const toForm = (p: PremadeRow | null, data: MarketingData, category: string): Form => ({
  pillar_id: p?.pillar_id ?? data.pillars.find((x) => !x.archived_at)?.id ?? "",
  series_id: p?.series_id ?? "",
  new_subtopic_name: "",
  business: p?.business ?? "botaniqals",
  status: p?.status ?? "drafting",
  intent: p?.intent ?? "organic",
  picture_format: p?.picture_format ?? (category === "picture_post" ? "single_image" : ""),
  hook: p?.hook ?? "",
  caption: p?.caption ?? "",
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
  product_ids: p?.product_ids ?? [],
  clear_title: false,
  clear_imported_tags: false,
  clear_extra_hashtags: false,
});
const formBody = (v: Form) => ({
  ...v,
  script_beats: v.script_beats.map(({ time, beat }) => ({ time, beat })),
  series_id: v.series_id && v.series_id !== "__new" ? v.series_id : null,
  new_subtopic_name: v.series_id === "__new" ? v.new_subtopic_name.trim() : null,
});

/** The name the post will have after saving (and the letter a new subtopic would get). */
export function nextNameFor(data: MarketingData, item: PremadeRow | null, v: Pick<Form, "pillar_id" | "series_id" | "new_subtopic_name">): { name: string | null; newLetter: string | null; moves: boolean } {
  const pillar = data.pillars.find((p) => p.id === v.pillar_id);
  if (!pillar) return { name: null, newLetter: null, moves: false };
  const sameGroup = !!item && item.pillar_id === v.pillar_id && (item.series_id ?? "") === v.series_id;
  if (sameGroup && item) return { name: item.name, newLetter: null, moves: false };
  if (v.series_id === "__new") {
    try {
      const letter = nextSubtopicLetter(data.series.filter((s) => s.pillar_id === pillar.id).map((s) => s.code));
      return { name: postName(pillar.code, letter, 1), newLetter: letter, moves: !!item };
    } catch {
      return { name: null, newLetter: null, moves: !!item };
    }
  }
  const s = v.series_id ? data.series.find((x) => x.id === v.series_id) : null;
  return { name: postName(pillar.code, s?.code ?? null, (s ? s.last_post_number : pillar.last_unsorted_post_number) + 1), newLetter: null, moves: !!item };
}

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
  onSaved: (id: string, message: string) => Promise<void>;
  onSchedule: (p: PremadeRow) => void;
  reload: () => Promise<void>;
}) {
  const [v, setV] = useState<Form>(() => toForm(item, data, category));
  const initial = useRef(JSON.stringify(formBody(toForm(item, data, category))));
  // A new post's assets and needs live here until the first save.
  const [draftAssets, setDraftAssets] = useState<string[]>([]);
  const [draftNeeds, setDraftNeeds] = useState<AssetNeed[]>([]);
  const [pickingAssets, setPickingAssets] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [closingOpen, setClosingOpen] = useState(false);
  const set = <K extends keyof Form>(k: K) => (x: Form[K]) => setV((s) => ({ ...s, [k]: x }));
  const dirty = JSON.stringify(formBody(v)) !== initial.current || draftAssets.length > 0 || draftNeeds.length > 0;
  const beats = v.script_beats.map(({ time, beat }) => ({ time, beat }));
  const subId = v.series_id && v.series_id !== "__new" ? v.series_id : null;
  const legacyTags = v.clear_extra_hashtags ? null : item?.hashtags ?? null;
  const tags = tagsForPost(data, { series_id: subId, product_ids: v.product_ids, hashtags: legacyTags });
  const finalCaption = composeFinalCaption(v.caption, tags);
  const addedTags = v.caption.trim() ? tagsNotIn(v.caption, tags).length : 0;
  const needs = item ? item.asset_needs : draftNeeds;
  const assetIds = item ? item.asset_ids : draftAssets;
  const gate = gateView(data, {
    id: item?.id ?? "new",
    category,
    pillar_id: v.pillar_id,
    series_id: subId,
    product_ids: v.product_ids,
    hashtags: legacyTags,
    hook: category === "reel" ? v.hook : item?.hook ?? null,
    caption: v.caption,
    script_beats: category === "reel" ? beats : item?.script_beats ?? [],
    cta_text: v.cta_text,
    asset_needs: needs,
    needs_customer_permission: v.needs_customer_permission,
    permission_confirmed_at: item?.permission_confirmed_at ?? null,
    risky_ack_hash: item?.risky_ack_hash ?? null,
  });
  const next = nextNameFor(data, item, v);
  const save = async () => {
    if (v.series_id === "__new" && !v.new_subtopic_name.trim()) {
      setErrors({ new_subtopic_name: "Enter the new subtopic's name." });
      return setMessage("Some fields are missing or not valid.");
    }
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      const body = formBody(v);
      const r = item
        ? await updatePremadeApi(item.id, { ...body, expected_updated_at: item.updated_at })
        : await createPremadeApi({ ...body, category, asset_ids: draftAssets, asset_needs: draftNeeds });
      initial.current = JSON.stringify(body);
      setDraftAssets([]);
      setDraftNeeds([]);
      setNotice(r.notice);
      await onSaved(r.id, `Saved ${r.name}${r.notice ? `. ${r.notice}` : ""}`);
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
  const setSavedAssets = async (ids: string[]) => {
    if (!item) return setDraftAssets(ids);
    for (const id of ids.filter((x) => !item.asset_ids.includes(x))) await needsActionApi(item.id, { op: "attach_asset", asset_id: id });
    for (const id of item.asset_ids.filter((x) => !ids.includes(x))) await needsActionApi(item.id, { op: "detach_asset", asset_id: id });
    await reload();
  };
  const moveBeat = (from: number, to: number) =>
    setV((s) => {
      if (to < 0 || to >= s.script_beats.length || from === to) return s;
      const list = [...s.script_beats];
      const [x] = list.splice(from, 1);
      list.splice(to, 0, x);
      return { ...s, script_beats: list };
    });
  const flags = item?.flags ?? [];
  const title = item ? item.name : category === "reel" ? "New reel" : "New picture post";
  const scriptText = [v.hook, ...v.script_beats.map((b) => `${b.time ? `${b.time}  ` : ""}${b.beat}`)].filter(Boolean).join("\n");
  const pillar = data.pillars.find((p) => p.id === v.pillar_id);
  const subs = data.series.filter((s) => s.pillar_id === v.pillar_id && (!s.archived_at || s.id === v.series_id));
  const hasTags = new Set(data.profiles.filter((p) => parseHashtags(p.hashtags).tags.length > 0).map((p) => p.formulation_product_id));
  const hits = gate.hits;

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
            <button type="button" className={`${btnPrimary} ${touch}`} onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
      }
    >
      <ErrorSummary message={message} errors={errors} />
      {notice && <p className={warnBox} role="status">{notice}</p>}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select
          name="pm-pillar"
          label="Main topic"
          value={v.pillar_id}
          onChange={(x) => setV((s) => ({ ...s, pillar_id: x, series_id: "", new_subtopic_name: "" }))}
          options={data.pillars.filter((p) => !p.archived_at || p.id === v.pillar_id).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))}
          error={errors.pillar_id}
        />
        <Select
          name="pm-subtopic"
          label="Subtopic"
          value={v.series_id}
          onChange={set("series_id")}
          options={[
            { value: "", label: "None for now" },
            ...subs.map((s) => ({ value: s.id, label: `${s.code ?? "?"} · ${s.name}` })),
            { value: "__new", label: "Create a new subtopic" },
          ]}
          error={errors.series_id}
        />
        {v.series_id === "__new" && (
          <div className="sm:col-span-2">
            <TextField name="pm-new-subtopic" label="New subtopic name" value={v.new_subtopic_name} onChange={set("new_subtopic_name")} required error={errors.new_subtopic_name} />
            {next.newLetter && pillar && <p className="mt-1 text-xs" data-testid="new-subtopic-letter">Will be created as subtopic {pillar.code}{next.newLetter}.</p>}
          </div>
        )}
        <div className="text-sm sm:col-span-2" data-testid="next-name">
          {item ? (
            <>
              <p>Name: <span className="font-semibold">{item.name}</span></p>
              {next.moves && next.name && <p className={warnBox}>Saving renames {item.name} to {next.name}.</p>}
              {item.name_history.length > 0 && <p className="text-xs">Previous names: {item.name_history.map((h) => h.name).join(", ")}</p>}
            </>
          ) : (
            <p>Next name: <span className="font-semibold">{next.name ?? "…"}</span></p>
          )}
        </div>
        {item?.title && !v.clear_title && (
          <p className="flex items-center gap-2 text-xs sm:col-span-2">Imported title: {item.title} <button type="button" className={btn} onClick={() => set("clear_title")(true)}>Clear</button></p>
        )}
      </section>

      {flags.length > 0 && <FlagsSection flags={flags} onDismiss={(k) => action({ action: "dismiss_flag", flag_key: k })} />}

      <section className={`${card} grid grid-cols-2 gap-3 sm:grid-cols-4`}>
        <Select name="pm-status" label="Status" value={v.status} onChange={set("status")} options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} error={errors.status} />
        <Select name="pm-intent" label="Intent" value={v.intent} onChange={set("intent")} options={Object.entries(INTENT_LABEL).map(([value, label]) => ({ value, label }))} />
        <Select name="pm-business" label="Business" value={v.business} onChange={set("business")} options={BUSINESS_OPTIONS} />
        <TextField name="pm-category" label="Category" value={category === "reel" ? "Reel" : "Picture post"} onChange={() => undefined} disabled />
        <fieldset className="col-span-2 sm:col-span-4">
          <legend className="mb-1 text-xs font-medium">Products mentioned</legend>
          <div className="flex flex-wrap gap-3">
            {data.products.map((p) => (
              <label key={p.id} className={`flex items-center gap-2 text-sm ${touch}`}>
                <input type="checkbox" checked={v.product_ids.includes(p.id)} onChange={() => set("product_ids")(v.product_ids.includes(p.id) ? v.product_ids.filter((x) => x !== p.id) : [...v.product_ids, p.id])} />
                {p.name}
                {hasTags.has(p.id) && <span className="text-[11px]">(has hashtags)</span>}
              </label>
            ))}
          </div>
          {item && item.products_mentioned.length > 0 && !v.clear_imported_tags && (
            <p className="mt-1 flex flex-wrap items-center gap-1 text-xs">
              Imported tags: {item.products_mentioned.map((t) => <Chip key={t} tone="zinc">{t}</Chip>)}
              <button type="button" className={btn} onClick={() => set("clear_imported_tags")(true)}>Clear</button>
            </p>
          )}
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField name="pm-window" label="Best window" value={v.best_window_text} onChange={set("best_window_text")} />
            <TextField name="pm-window-why" label="Why this window" value={v.best_window_why} onChange={set("best_window_why")} />
          </div>
        </section>
      ) : (
        <section className={`${card} space-y-3`}>
          <h3 className="text-sm font-semibold">Picture post</h3>
          <Select name="pm-format" label="Format" value={v.picture_format} onChange={set("picture_format")} options={Object.entries(FORMAT_LABEL).map(([value, label]) => ({ value, label }))} />
          <TextArea name="pm-visual-notes" label="Visual notes" value={v.visual_notes} onChange={set("visual_notes")} rows={2} />
        </section>
      )}

      <section className={`${card} space-y-2`}>
        <div className="flex items-center justify-between">
          <label htmlFor="f-pm-caption" className="text-sm font-semibold">Caption{category === "reel" ? " (optional)" : ""}</label>
          <button type="button" className={btn} onClick={() => setClosingOpen(true)}>Insert closing line</button>
        </div>
        <textarea id="f-pm-caption" rows={Math.min(30, Math.max(8, v.caption.split("\n").length + 1))} value={v.caption} onChange={(e) => set("caption")(e.target.value)} className={`${input} [field-sizing:content]`} aria-invalid={!!errors.caption} />
        <p className="text-[11px]">{v.caption.length} characters. Hashtags from the subtopic and products are added automatically when posted.</p>
        {item?.hashtags && !v.clear_extra_hashtags && (
          <p className="flex flex-wrap items-center gap-2 rounded border border-zinc-200 p-2 text-xs" data-testid="extra-hashtags">
            Extra hashtags (from before): {item.hashtags}
            <button type="button" className={btn} onClick={() => set("clear_extra_hashtags")(true)}>Clear</button>
          </p>
        )}
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold">Final caption ({addedTags} hashtag{addedTags === 1 ? "" : "s"} added)</p>
            <CopyButton text={finalCaption} labelText="Copy" />
          </div>
          <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap text-xs" data-testid="final-caption">{finalCaption || "(empty)"}</p>
        </div>
      </section>

      {(hits.avoid.length > 0 || hits.risky.length > 0) && (
        <section className={warnBox} data-testid="editor-hits">
          <p className="font-medium">Words to review (these never block saving, only Ready):</p>
          {hits.avoid.length > 0 && <p><Chip tone="red">Avoid list</Chip> {hits.avoid.map((h) => `“${h.phrase}”`).join(", ")}</p>}
          {hits.risky.length > 0 && <p><Chip tone="amber">Watch words</Chip> {hits.risky.map((h) => `“${h.phrase}”`).join(", ")}</p>}
          <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-200 bg-white p-2 text-xs">
            <Highlighted text={[category === "reel" ? v.hook : "", finalCaption, ...(category === "reel" ? v.script_beats.map((b) => b.beat) : [])].filter(Boolean).join("\n\n")} hits={hits} />
          </div>
        </section>
      )}

      <section className={`${card} space-y-2`} data-testid="assets-section">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Assets ({assetIds.length})</h3>
          <button type="button" className={btn} onClick={() => setPickingAssets(true)}>Add assets</button>
        </div>
        <AssetCards data={data} ids={assetIds} onRemove={(id) => void setSavedAssets(assetIds.filter((x) => x !== id))} />
        {!item && assetIds.length > 0 && <p className="text-[11px]">Saved with the post.</p>}
      </section>

      <NeedsSection
        data={data}
        item={item}
        reload={reload}
        business={v.business}
        productIds={v.product_ids}
        draft={item ? undefined : { needs: draftNeeds, setNeeds: setDraftNeeds, addAsset: (id) => setDraftAssets((s) => (s.includes(id) ? s : [...s, id])) }}
      />

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
            <input type="checkbox" checked={item.risky_ack_hash === gate.hash} disabled={dirty || item.risky_ack_hash === gate.hash} onChange={() => action({ action: "ack_words", hash: gate.hash })} />
            Words reviewed{item.risky_ack_hash === gate.hash && item.risky_ack_by_name ? ` (by ${item.risky_ack_by_name})` : ""}
            {dirty && <span className="text-xs">Save your changes first.</span>}
          </label>
        )}
      </section>

      <TextArea name="pm-notes" label="Notes" value={v.notes} onChange={set("notes")} rows={3} />

      {v.status === "ready" && gate.blockers.length > 0 && (
        <div className={errorBox} role="alert" data-testid="library-ready-blockers">
          <p className="font-medium">Before this can be Ready:</p>
          <ul className="list-disc pl-4">{gate.blockers.map((b) => <li key={b.key}>{b.message}</li>)}</ul>
        </div>
      )}
      {pickingAssets && (
        <AssetCardPicker
          data={data}
          mode="multi"
          initial={assetIds}
          title="Add assets"
          reload={reload}
          onClose={() => setPickingAssets(false)}
          onSave={async (ids) => {
            await setSavedAssets(ids);
            setPickingAssets(false);
          }}
        />
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

