"use client";

/**
 * Marketing Hub pieces that join the Ad Library to the calendar and the
 * reference data: the "Add to calendar" dialog (also "Start from the
 * library"), best-time hints, rhythm hints, the pillar mix strip, the
 * "Based on" notice with "Update from library", the Best Times tab and the
 * Admin-only avoid list (Settings tab).
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { saveAvoidPhraseApi, saveRhythmApi, scheduleFromLibraryApi, syncFromLibraryApi, updateWindowApi, type GrowthApiError, type MarketingData } from "@/lib/growth/client";
import { hashPremadeText, premadeReadyCheck, premadeScanText, scanBoth } from "@/lib/growth/adLibrary";
import { DAY_SHORT, PLATFORM_LABEL, dayName, pillarMix, rhythmFor, scheduleHint, weekdayOf, type WindowRow } from "@/lib/growth/scheduling";
import { addDays, todayNy } from "@/lib/growth/dates";
import type { PremadeRow, WindowRowDb } from "@/lib/growth/libraryService";
import type { Post } from "@/lib/growth/marketingService";
import { Badge, Checkbox, Chip, ConfirmDialog, Dialog, ErrorSummary, Select, TextField, btn, btnPrimary, card, errorBox, fmtDate, infoBox, input, warnBox } from "./GrowthUi";

const touch = "min-h-11";
const PLATFORMS = ["instagram", "tiktok", "facebook", "youtube"] as const;
const QUALITY_LABEL: Record<string, string> = { peak: "Peak", good: "Good", weak: "Weak", avoid: "Avoid", none: "No reliable peak" };
const QUALITY_CLASS: Record<string, string> = {
  peak: "bg-emerald-100 border-emerald-300",
  good: "bg-emerald-50 border-emerald-200",
  weak: "bg-amber-50 border-amber-200",
  avoid: "bg-red-50 border-red-300",
  none: "bg-zinc-50 border-zinc-200",
};
const HINT_CLASS: Record<string, string> = { in_window: "text-emerald-800", outside_window: "text-amber-800", avoid: "text-red-700", weak: "text-amber-800", no_data: "text-black", paid_skip: "text-black" };

const windowsOf = (data: MarketingData): WindowRow[] => data.windows.map((w) => ({ ...w, ranges: Array.isArray(w.ranges) ? w.ranges : [] }));
const dayNote = (data: MarketingData, date: string) => data.dayNotes.find((n) => n.day_of_week === weekdayOf(date))?.note ?? null;
const pillarById = (data: MarketingData, id: string | null | undefined) => data.pillars.find((p) => p.id === id) ?? null;

/** The blockers a library item would show at Ready (computed in the browser for warnings only; the server decides). */
export function itemBlockers(data: MarketingData, p: PremadeRow) {
  const risky = data.riskyWords.filter((w) => !w.archived_at).map((w) => w.phrase);
  const avoid = data.avoidPhrases.filter((w) => !w.archived_at).map((w) => w.phrase);
  const hits = scanBoth(premadeScanText(p), risky, avoid);
  return premadeReadyCheck({ premade: p, selectedClaims: data.claims.filter((c) => p.claim_ids.includes(c.id)), hits, currentTextHash: hashPremadeText(p) });
}

// --- Hints ------------------------------------------------------------------------------------------
/** "Tuesday on TikTok: 2 to 6pm (peak)", plus the day's note. Never blocks anything. */
export function ScheduleHintLine({ data, date, time, platform, intent }: { data: MarketingData; date: string; time?: string | null; platform: string; intent?: string | null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !platform) return null;
  if (intent === "paid") return <p className="text-[11px] text-black">{data.referenceNotes.paid_ads_note || "Paid ads follow the ad platform's delivery, not posting windows."}</p>;
  if (!PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) return null;
  const h = scheduleHint({ date, time, platform, windows: windowsOf(data), intent });
  const note = dayNote(data, date);
  return (
    <div className="text-[11px]" data-testid={`hint-${platform}`}>
      <p className={HINT_CLASS[h.state]}>{h.message}</p>
      {note && <p className="text-black">{dayName(weekdayOf(date))}: {note}</p>}
    </div>
  );
}

export function rhythmLabel(data: MarketingData, date: string): string | null {
  const r = rhythmFor(date, data.rhythm);
  return r ? r.label : null;
}

// --- Pillar mix --------------------------------------------------------------------------------------
export function PillarMixStrip({ data }: { data: MarketingData }) {
  const today = todayNy();
  const pillarOf = useMemo(() => new Map(data.premades.map((p) => [p.id, p.pillar_id])), [data.premades]);
  const mix = pillarMix({
    posts: data.posts.map((p) => ({ ...p, pillar_id: p.premade_post_id ? pillarOf.get(p.premade_post_id) ?? null : null })),
    pillars: data.pillars,
    from: addDays(today, -27),
    to: today,
  });
  if (mix.length === 0) return null;
  return (
    <div className={`${card} space-y-1`} data-testid="pillar-mix">
      <p className="text-xs font-semibold">Pillar mix (last 28 days)</p>
      <div className="flex flex-wrap gap-1">
        {mix.map((m) => (
          <span key={m.pillar_id} className={`rounded border px-2 py-0.5 text-xs ${m.count === 0 ? "border-amber-300 bg-amber-50 font-medium" : "border-zinc-200 bg-white"}`} title={m.name}>
            {m.code} {m.name}: {m.count}
          </span>
        ))}
      </div>
      <p className="text-[11px]">Counts calendar entries made from the library that are past Idea. Pillars at zero are highlighted.</p>
    </div>
  );
}

// --- "Based on" notice on a calendar entry -----------------------------------------------------------
export function LibraryBasis({ data, post, onSynced }: { data: MarketingData; post: Post; onSynced: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  if (!post.premade_post_id) return null;
  const p = data.premades.find((x) => x.id === post.premade_post_id);
  if (!p) return null;
  const changed = !!post.premade_synced_at && new Date(p.updated_at).getTime() > new Date(post.premade_synced_at).getTime();
  const posted = post.status === "posted";
  const open = p.asset_needs.filter((n) => n.status !== "ready").length;
  return (
    <div className={`${infoBox} space-y-1`} data-testid="library-basis">
      <p>
        Based on: <Link className="font-medium underline" href={`/growth/marketing?tab=library&item=${p.id}`}>{p.display_name}</Link>
      </p>
      {open > 0 && <p className="text-amber-800">The library item still needs {open} asset{open === 1 ? "" : "s"}.</p>}
      {changed && (
        <div className="flex flex-wrap items-center gap-2">
          <span>The library version changed on {fmtDate(p.updated_at.slice(0, 10))}.</span>
          <button type="button" className={btn} disabled={posted} title={posted ? "Posted entries can't be updated." : undefined} onClick={() => setConfirm(true)}>
            Update from library
          </button>
        </div>
      )}
      {notices.map((n) => <p key={n}>{n}</p>)}
      {confirm && (
        <ConfirmDialog
          title="Update from the library?"
          confirmLabel="Update"
          busy={busy}
          error={error}
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              const r = await syncFromLibraryApi(post.id);
              setNotices(r.notices);
              setConfirm(false);
              onSynced();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>This replaces the entry&apos;s caption, hashtags, attached assets and claims with the library version.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

// --- Add to calendar ------------------------------------------------------------------------------------
export function AddToCalendarDialog({
  data,
  premade,
  initialDate,
  onClose,
  onDone,
}: {
  data: MarketingData;
  premade: PremadeRow | null;
  initialDate?: string | null;
  onClose: () => void;
  onDone: (ids: string[]) => void;
}) {
  const [pickedId, setPickedId] = useState<string | null>(premade?.id ?? null);
  const item = data.premades.find((p) => p.id === pickedId) ?? null;
  const [date, setDate] = useState(initialDate ?? "");
  const [time, setTime] = useState("");
  const [platforms, setPlatforms] = useState<string[]>(premade?.platforms?.length ? [...premade.platforms] : ["instagram"]);
  const [owner, setOwner] = useState("");
  const [confirmDup, setConfirmDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ ids: string[]; warnings: string[]; open_needs: number } | null>(null);

  const choose = (p: PremadeRow) => {
    setPickedId(p.id);
    setPlatforms(p.platforms.length ? [...p.platforms] : ["instagram"]);
    setConfirmDup(false);
  };
  const blockers = item && item.status === "ready" ? itemBlockers(data, item) : [];
  const already = item && !item.is_recurring ? item.next_scheduled ?? item.last_posted : null;
  const rhythm = date ? rhythmLabel(data, date) : null;

  const save = async () => {
    if (!item) return;
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      const r = await scheduleFromLibraryApi(item.id, { date, time: time || null, platforms, owner_account_id: owner || null, confirm_duplicate: confirmDup });
      setDone(r);
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Dialog title="Added to the calendar" onClose={() => onDone(done.ids)}>
        <div className="space-y-2 text-black" data-testid="schedule-done">
          <p>{done.ids.length} calendar entr{done.ids.length === 1 ? "y" : "ies"} added.</p>
          <ul className="list-disc pl-5 text-sm">
            {done.ids.map((id, i) => (
              <li key={id}>
                <Link className="underline" href={`/growth/marketing?tab=calendar&post=${id}`}>Open entry {i + 1}</Link>
              </li>
            ))}
          </ul>
          {done.open_needs > 0 && <p className={warnBox}>The library item still needs {done.open_needs} asset{done.open_needs === 1 ? "" : "s"}.</p>}
          {done.warnings.length > 0 && <div className={warnBox}><ul className="list-disc pl-4">{done.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          <div className="flex justify-end"><button type="button" className={btnPrimary} onClick={() => onDone(done.ids)}>Done</button></div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={item ? `Add to calendar: ${item.display_name}` : "Start from the library"} onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        {!premade && <LibraryPicker data={data} date={date} selectedId={pickedId} onPick={choose} />}
        {item && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <TextField name="sch-date" label="Date" type="date" value={date} onChange={setDate} required error={errors.date} />
              <TextField name="sch-time" label="Time (optional)" type="time" value={time} onChange={setTime} error={errors.time} />
              <Select name="sch-owner" label="Owner" value={owner} onChange={setOwner} options={[{ value: "", label: "Nobody" }, ...data.employees.map((e) => ({ value: e.id, label: e.name }))]} error={errors.owner_account_id} />
            </div>
            <fieldset>
              <legend className="mb-1 text-xs font-medium">Platforms (one calendar entry each)</legend>
              <div className="flex flex-wrap gap-3">
                {PLATFORMS.map((pl) => (
                  <label key={pl} className={`flex items-center gap-2 text-sm ${touch}`}>
                    <input type="checkbox" checked={platforms.includes(pl)} onChange={() => setPlatforms((s) => (s.includes(pl) ? s.filter((x) => x !== pl) : [...s, pl]))} />
                    {PLATFORM_LABEL[pl]}
                  </label>
                ))}
              </div>
            </fieldset>
            {item.category === "reel" && item.best_window_text && (
              <p className={infoBox}>Best window for this reel: {item.best_window_text}{item.best_window_why ? ` (${item.best_window_why})` : ""}</p>
            )}
            {rhythm && <p className="text-xs">Rhythm for {dayName(weekdayOf(date))}: {rhythm}</p>}
            {date && (
              <div className="space-y-1">
                {item.intent === "paid" ? (
                  <ScheduleHintLine data={data} date={date} platform="instagram" intent="paid" />
                ) : (
                  platforms.map((pl) => <ScheduleHintLine key={pl} data={data} date={date} time={time} platform={pl} />)
                )}
              </div>
            )}
            {blockers.length > 0 && (
              <div className={warnBox} data-testid="schedule-blockers">
                <p className="font-medium">Not ready yet, so the entries will be Editing:</p>
                <ul className="list-disc pl-4">{blockers.map((b) => <li key={b.key}>{b.message}</li>)}</ul>
              </div>
            )}
            {already && (
              <div className={warnBox} data-testid="already-scheduled">
                <p>Already on the calendar for {fmtDate(already)}.</p>
                <Checkbox name="sch-dup" label="Add it again anyway" checked={confirmDup} onChange={setConfirmDup} />
              </div>
            )}
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} disabled={!item || busy || !date || platforms.length === 0 || (!!already && !confirmDup)} onClick={save}>
            {busy ? "Adding…" : `Add ${platforms.length > 1 ? `${platforms.length} entries` : "to calendar"}`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function LibraryPicker({ data, date, selectedId, onPick }: { data: MarketingData; date: string; selectedId: string | null; onPick: (p: PremadeRow) => void }) {
  const [cat, setCat] = useState<"reel" | "picture_post">("reel");
  const [q, setQ] = useState("");
  const [matchRhythm, setMatchRhythm] = useState(false);
  const r = date ? rhythmFor(date, data.rhythm) : null;
  const list = data.premades
    .filter((p) => !p.archived_at && p.category === cat)
    .filter((p) => !q.trim() || p.display_name.toLowerCase().includes(q.trim().toLowerCase()) || p.title.toLowerCase().includes(q.trim().toLowerCase()))
    .filter((p) => !matchRhythm || !r || r.pillar_ids.includes(p.pillar_id))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  const count = (c: string) => data.premades.filter((p) => !p.archived_at && p.category === c).length;
  return (
    <div className="space-y-2" data-testid="library-picker">
      <div className="flex gap-1 border-b border-zinc-200" role="tablist">
        {(["reel", "picture_post"] as const).map((c) => (
          <button key={c} type="button" role="tab" aria-selected={cat === c} onClick={() => setCat(c)} className={`border-b-2 px-3 py-2 text-sm font-medium ${cat === c ? "border-emerald-600" : "border-transparent"}`}>
            {c === "reel" ? "Reels" : "Picture posts"} ({count(c)})
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Search by name" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} className={`${input} w-64`} />
        <Checkbox name="pick-rhythm" label={r ? `Match this day's rhythm (${r.label})` : "Match this day's rhythm"} checked={matchRhythm} onChange={setMatchRhythm} />
      </div>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-zinc-200 p-1">
        {list.length === 0 && <li className="p-2 text-xs">Nothing matches.</li>}
        {list.map((p) => {
          const paused = p.status === "paused";
          const openFlags = p.flags.filter((f) => !f.dismissed_at).length;
          const needs = p.asset_needs.filter((n) => n.status !== "ready").length;
          return (
            <li key={p.id}>
              <button
                type="button"
                disabled={paused}
                onClick={() => onPick(p)}
                className={`flex w-full flex-wrap items-center gap-2 rounded px-2 py-2 text-left text-sm ${touch} ${selectedId === p.id ? "bg-emerald-50 ring-1 ring-emerald-400" : "hover:bg-zinc-50"} ${paused ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <span className="font-medium">{p.display_name}</span>
                <Chip tone={p.status === "ready" ? "green" : paused ? "amber" : "zinc"}>{p.status[0].toUpperCase() + p.status.slice(1)}</Chip>
                {needs > 0 && <Badge tone="amber">{needs} asset{needs === 1 ? "" : "s"} needed</Badge>}
                {openFlags > 0 && <Badge>{openFlags} flag{openFlags === 1 ? "" : "s"}</Badge>}
                {paused && <span className="text-xs">Paused: reactivate it first</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- Best Times tab -------------------------------------------------------------------------------------
const BT_PLATFORMS = [
  { key: "instagram", label: "Instagram and Reels" },
  { key: "tiktok", label: "TikTok" },
  { key: "facebook", label: "Facebook" },
] as const;
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function BestTimesTab({ data, reload }: { data: MarketingData; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<WindowRowDb | null>(null);
  const reels = data.premades.filter((p) => !p.archived_at && p.category === "reel" && p.best_window_text).sort((a, b) => a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name));
  const cell = (day: number, platform: string) => data.windows.find((w) => w.day_of_week === day && w.platform === platform) ?? null;
  const notes = data.referenceNotes;
  return (
    <section className="space-y-4">
      <p className="text-xs font-medium">Times shown in Eastern Time (America/New_York).</p>
      {data.windows.length === 0 && <p className="rounded-md border border-dashed border-zinc-300 p-4 text-center text-sm">No posting windows yet. They arrive with the playbook import.</p>}
      <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
        <table className="min-w-full text-left text-xs" data-testid="best-times-table">
          <thead className="bg-zinc-50">
            <tr>
              <th className="px-3 py-2 font-semibold">Day</th>
              {BT_PLATFORMS.map((p) => <th key={p.key} className="px-3 py-2 font-semibold">{p.label}</th>)}
              <th className="px-3 py-2 font-semibold">YouTube Shorts</th>
            </tr>
          </thead>
          <tbody>
            {DAY_ORDER.map((d) => {
              const note = data.dayNotes.find((n) => n.day_of_week === d)?.note;
              return (
                <tr key={d} className="border-t border-zinc-100 align-top">
                  <td className="px-3 py-2">
                    <p className="font-medium">{dayName(d)}</p>
                    {note && <p className="mt-1 max-w-48 text-[11px]">{note}</p>}
                  </td>
                  {BT_PLATFORMS.map((p) => {
                    const w = cell(d, p.key);
                    return (
                      <td key={p.key} className="px-2 py-2">
                        {w ? (
                          <button type="button" onClick={() => setEditing(w)} className={`w-full rounded border px-2 py-1 text-left ${QUALITY_CLASS[w.quality] ?? ""} ${touch}`} aria-label={`Edit ${dayName(d)} on ${p.label}`}>
                            <span className="block">{w.window_text || "—"}</span>
                            <span className="text-[11px]">{QUALITY_LABEL[w.quality]}</span>
                            {w.source === "own_data" && <span className="ml-1"><Badge tone="blue">Own data</Badge></span>}
                          </button>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2">No data</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(notes.best_times_source || notes.paid_ads_note || notes.ad_windows_note) && (
        <div className="space-y-2">
          {notes.best_times_source && <div className={card}><p className="text-xs font-semibold">Source and caution</p><p className="whitespace-pre-line text-sm">{notes.best_times_source}</p></div>}
          {notes.paid_ads_note && <div className={card}><p className="text-xs font-semibold">Paid ads</p><p className="whitespace-pre-line text-sm">{notes.paid_ads_note}</p></div>}
          {notes.ad_windows_note && <div className={card}><p className="text-xs font-semibold">About the per-ad windows</p><p className="whitespace-pre-line text-sm">{notes.ad_windows_note}</p></div>}
        </div>
      )}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold">By reel concept</h2>
        {reels.length === 0 ? (
          <p className="text-xs">No reels have a best window yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
            <table className="min-w-full text-left text-xs" data-testid="reel-windows">
              <thead className="bg-zinc-50"><tr>{["Reel", "Best window", "Why"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
              <tbody>
                {reels.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-100 align-top">
                    <td className="px-3 py-2"><Link className="underline" href={`/growth/marketing?tab=library&item=${r.id}`}>{r.display_name}</Link></td>
                    <td className="px-3 py-2">{r.best_window_text}</td>
                    <td className="px-3 py-2">{r.best_window_why ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <RhythmEditor data={data} reload={reload} />
      {editing && <WindowDialog row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
    </section>
  );
}

function WindowDialog({ row, onClose, onSaved }: { row: WindowRowDb; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(row.window_text ?? "");
  const [quality, setQuality] = useState<string>(row.quality);
  const [ranges, setRanges] = useState<Array<{ start: string; end: string; note: string }>>(
    (Array.isArray(row.ranges) ? row.ranges : []).map((r) => ({ start: r.start, end: r.end, note: r.note ?? "" })),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Dialog title={`${dayName(row.day_of_week)} on ${PLATFORM_LABEL[row.platform] ?? row.platform}`} onClose={onClose}>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <TextField name="w-text" label="Window text" value={text} onChange={setText} error={errors.window_text} />
        <Select name="w-quality" label="Quality" value={quality} onChange={setQuality} options={Object.entries(QUALITY_LABEL).map(([value, label]) => ({ value, label }))} error={errors.quality} />
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium">Ranges (24-hour, Eastern Time)</legend>
          {ranges.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input aria-label="Start" type="time" value={r.start} onChange={(e) => setRanges(ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} className={`${input} w-32`} />
              <span>to</span>
              <input aria-label="End" type="time" value={r.end} onChange={(e) => setRanges(ranges.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} className={`${input} w-32`} />
              <input aria-label="Note" placeholder="Note" value={r.note} onChange={(e) => setRanges(ranges.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} className={`${input} w-28`} />
              <button type="button" className={btn} onClick={() => setRanges(ranges.filter((_, j) => j !== i))} aria-label="Remove range">✕</button>
            </div>
          ))}
          {errors.ranges && <p className="text-xs text-red-700">{errors.ranges}</p>}
          <button type="button" className={btn} onClick={() => setRanges([...ranges, { start: "12:00", end: "13:00", note: "" }])} disabled={ranges.length >= 6}>Add range</button>
        </fieldset>
        <p className="text-[11px]">Saving marks this window as your own data.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={btnPrimary}
            onClick={async () => {
              try {
                await updateWindowApi(row.id, { window_text: text, quality, ranges });
                onSaved();
              } catch (e) {
                setMessage((e as Error).message);
                setErrors((e as GrowthApiError).fields ?? {});
              }
            }}
          >
            Save
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function RhythmEditor({ data, reload }: { data: MarketingData; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<MarketingData["rhythm"][number] | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = data.rhythm.filter((r) => !!r.archived_at === showArchived).sort((a, b) => (Math.min(...a.days.map((d) => (d + 6) % 7)) - Math.min(...b.days.map((d) => (d + 6) % 7))));
  const pillarText = (ids: string[]) => ids.map((id) => pillarById(data, id)).filter(Boolean).map((p) => `${p!.code} - ${p!.name}`).join(", ") || "—";
  return (
    <div className="space-y-2" data-testid="rhythm-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Posting rhythm</h2>
        <div className="flex items-center gap-3">
          <Checkbox name="rh-archived" label="Show archived" checked={showArchived} onChange={setShowArchived} />
          <button type="button" className={btnPrimary} onClick={() => setEditing("new")}>Add rhythm row</button>
        </div>
      </div>
      {error && <p className={errorBox}>{error}</p>}
      {rows.length === 0 ? (
        <p className="text-xs">No rhythm rows.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-zinc-50"><tr>{["Days", "Label", "Pillars", "Active", "Note", ""].map((h) => <th key={h || "a"} className="px-3 py-2 font-semibold">{h || <span className="sr-only">Actions</span>}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 align-top">
                  <td className="px-3 py-2">{[...r.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_SHORT[d]).join(", ")}</td>
                  <td className="px-3 py-2">{r.label}</td>
                  <td className="px-3 py-2">{pillarText(r.pillar_ids)}</td>
                  <td className="px-3 py-2">{r.active ? "Yes" : "No"}</td>
                  <td className="px-3 py-2">{r.note ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="flex justify-end gap-1">
                      {!r.archived_at && <button type="button" className={btn} onClick={() => setEditing(r)}>Edit</button>}
                      <button
                        type="button"
                        className={btn}
                        onClick={async () => {
                          setError(null);
                          try {
                            await saveRhythmApi(r.id, r.archived_at ? { restore: true } : { archive: true });
                            await reload();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        {r.archived_at ? "Restore" : "Archive"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <RhythmDialog data={data} row={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
    </div>
  );
}

function RhythmDialog({ data, row, onClose, onSaved }: { data: MarketingData; row: MarketingData["rhythm"][number] | null; onClose: () => void; onSaved: () => void }) {
  const [days, setDays] = useState<number[]>(row?.days ?? []);
  const [label, setLabel] = useState(row?.label ?? "");
  const [pillarIds, setPillarIds] = useState<string[]>(row?.pillar_ids ?? []);
  const [active, setActive] = useState(row?.active ?? true);
  const [note, setNote] = useState(row?.note ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <Dialog title={row ? "Edit rhythm row" : "New rhythm row"} onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <fieldset>
          <legend className="mb-1 text-xs font-medium">Days</legend>
          <div className="flex flex-wrap gap-3">
            {DAY_ORDER.map((d) => (
              <label key={d} className={`flex items-center gap-1 text-sm ${touch}`}>
                <input type="checkbox" checked={days.includes(d)} onChange={() => setDays(toggle(days, d))} /> {DAY_SHORT[d]}
              </label>
            ))}
          </div>
          {errors.days && <p className="text-xs text-red-700">{errors.days}</p>}
        </fieldset>
        <TextField name="rh-label" label="Label" value={label} onChange={setLabel} required error={errors.label} />
        <fieldset>
          <legend className="mb-1 text-xs font-medium">Pillars</legend>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-zinc-200 p-1">
            {data.pillars.filter((p) => !p.archived_at || pillarIds.includes(p.id)).map((p) => (
              <li key={p.id}>
                <label className={`flex items-center gap-2 text-sm ${touch}`}>
                  <input type="checkbox" checked={pillarIds.includes(p.id)} onChange={() => setPillarIds(toggle(pillarIds, p.id))} /> {p.code} - {p.name}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <Checkbox name="rh-active" label="Active" checked={active} onChange={setActive} />
        <TextField name="rh-note" label="Note" value={note} onChange={setNote} error={errors.note} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={btnPrimary}
            onClick={async () => {
              try {
                await saveRhythmApi(row?.id ?? null, { days, label, pillar_ids: pillarIds, active, note });
                onSaved();
              } catch (e) {
                setMessage((e as Error).message);
                setErrors((e as GrowthApiError).fields ?? {});
              }
            }}
          >
            Save
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Settings: avoid list (Admin only) -------------------------------------------------------------------
export const AVOID_NOTE = "Posts that contain these phrases show a red Avoid list chip. This is a review aid, not a legal check.";

export function AvoidListSection({ data, reload }: { data: MarketingData; reload: () => Promise<void> }) {
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
    <section className="space-y-3" data-testid="avoid-list">
      <h2 className="text-sm font-semibold">Avoid list</h2>
      <p className={infoBox}>{AVOID_NOTE}</p>
      {error && <p className={errorBox} role="alert">{error}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <TextField name="av-phrase" label="Phrase" value={phrase} onChange={setPhrase} />
        <TextField name="av-note" label="Note (optional)" value={note} onChange={setNote} />
        <button type="button" className={btnPrimary} onClick={async () => { if (await run(() => saveAvoidPhraseApi(null, { phrase, note }))) { setPhrase(""); setNote(""); } }}>Add phrase</button>
      </div>
      <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white">
        {data.avoidPhrases.length === 0 && <li className="px-3 py-2 text-sm">No phrases yet.</li>}
        {data.avoidPhrases.map((w) => (
          <li key={w.id} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm ${w.archived_at ? "opacity-60" : ""}`}>
            {editing?.id === w.id ? (
              <span className="flex flex-1 gap-2">
                <input aria-label="Phrase" value={editing.phrase} onChange={(e) => setEditing({ ...editing, phrase: e.target.value })} className={input} />
                <input aria-label="Note" value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} className={input} />
              </span>
            ) : (
              <span>
                <span className="font-medium text-red-700">{w.phrase}</span>
                {w.note && <span className="ml-2 text-xs">{w.note}</span>}
                <span className="ml-2"><Badge>{w.source === "playbook" ? "Playbook" : "Manual"}</Badge></span>
                {w.archived_at && <span className="ml-1"><Badge>Archived</Badge></span>}
              </span>
            )}
            <span className="flex gap-1">
              {editing?.id === w.id ? (
                <>
                  <button type="button" className={btnPrimary} onClick={async () => { if (await run(() => saveAvoidPhraseApi(w.id, { phrase: editing.phrase, note: editing.note }))) setEditing(null); }}>Save</button>
                  <button type="button" className={btn} onClick={() => setEditing(null)}>Cancel</button>
                </>
              ) : (
                <>
                  {!w.archived_at && <button type="button" className={btn} onClick={() => setEditing({ id: w.id, phrase: w.phrase, note: w.note ?? "" })}>Edit</button>}
                  <button type="button" className={btn} onClick={() => run(() => saveAvoidPhraseApi(w.id, w.archived_at ? { restore: true } : { archive: true }))}>{w.archived_at ? "Restore" : "Archive"}</button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
