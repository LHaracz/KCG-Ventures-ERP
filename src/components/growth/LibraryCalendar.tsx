"use client";

/**
 * Marketing Hub pieces that join the Ad Library to the calendar and the
 * reference data: the schedule modal (New post, Add to calendar, Edit
 * schedule), the entry popover (final caption, Mark posted, Remove),
 * best-time hints, rhythm hints, the pillar mix strip, the Best Times tab
 * and the Admin-only avoid list (Settings tab).
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { editScheduleApi, markPostedApi, removeFromCalendarApi, saveAvoidPhraseApi, saveRhythmApi, scheduleFromLibraryApi, updateWindowApi, type GrowthApiError, type MarketingData } from "@/lib/growth/client";
import { CALENDAR_PLATFORMS, DAY_SHORT, PLATFORM_LABEL, PLATFORM_SHORT, dayName, pillarMix, rhythmFor, scheduleHint, weekdayOf, type WindowRow } from "@/lib/growth/scheduling";
import { addDays, todayNy } from "@/lib/growth/dates";
import { matchesPostSearch, stripTrailingHashtagBlock } from "@/lib/growth/naming";
import { entryView, gateView } from "@/lib/growth/libraryView";
import type { PremadeRow, WindowRowDb } from "@/lib/growth/libraryService";
import type { Post } from "@/lib/growth/marketingService";
import { Badge, Checkbox, Chip, Dialog, ErrorSummary, Select, TextField, btn, btnPrimary, card, errorBox, fmtDate, infoBox, input, warnBox } from "./GrowthUi";
import { AssetCards } from "./AssetCardPicker";

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

// --- Calendar entries: name, chips, the schedule modal and the entry popover ------------------------------
/** A calendar entry's name: the library post's live name until it is Posted, then the frozen title. */
export const entryName = (data: MarketingData, post: Post) => entryView(data, post, data.premades).name;
/** "AA-2 · IG" */
export const entryChip = (data: MarketingData, post: Post) => `${entryName(data, post)} · ${PLATFORM_SHORT[post.platform] ?? post.platform}`;
/** The live rows of an entry's schedule group (or just the entry). */
export const groupOf = (data: MarketingData, post: Post) =>
  post.schedule_group_id ? data.posts.filter((p) => p.schedule_group_id === post.schedule_group_id && !p.archived_at) : [post];

/** One library post in the search list. */
function PostOption({ data, p }: { data: MarketingData; p: PremadeRow }) {
  const body = stripTrailingHashtagBlock(p.caption).body.replace(/\s+/g, " ").trim();
  return (
    <span className="block">
      <span className="font-bold">{p.name}</span> <span className="text-[11px]">{p.category === "reel" ? "Reel" : "Picture post"} · {p.status[0].toUpperCase() + p.status.slice(1)}</span>
      {body && <span className="block text-[11px]">{body.slice(0, 60)}{body.length > 60 ? "…" : ""}</span>}
      {p.status === "paused" && <span className="block text-[11px]">Paused: reactivate it first</span>}
      {data.duplicateNames.some((d) => d.post_ids.includes(p.id)) && <span className="block text-[11px]">Duplicate name</span>}
    </span>
  );
}

/**
 * New Post / Add to calendar / Edit schedule. Saving creates one entry per
 * platform (one schedule group) or, when editing, updates the whole group.
 */
export function ScheduleDialog({
  data,
  premadeId = null,
  entry = null,
  initialDate = null,
  onClose,
  onDone,
}: {
  data: MarketingData;
  premadeId?: string | null;
  entry?: Post | null;
  initialDate?: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const group = entry ? groupOf(data, entry) : [];
  const locked = group.filter((r) => r.status === "posted");
  const legacy = !!entry && !entry.premade_post_id;
  const [pickedId, setPickedId] = useState<string | null>(entry?.premade_post_id ?? premadeId);
  const item = data.premades.find((p) => p.id === pickedId) ?? null;
  const [q, setQ] = useState("");
  const [date, setDate] = useState(entry?.scheduled_date ?? initialDate ?? "");
  const [time, setTime] = useState(entry?.scheduled_time ?? "");
  const [platforms, setPlatforms] = useState<string[]>(entry ? [...new Set(group.map((r) => r.platform))] : ["instagram"]);
  const [anyway, setAnyway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const list = data.premades
    .filter((p) => !p.archived_at)
    .filter((p) => matchesPostSearch({ name: p.name, name_history: p.name_history, title: p.title, subtopicName: data.series.find((s) => s.id === p.series_id)?.name ?? null, caption: p.caption }, q))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const gate = item ? gateView(data, item) : null;
  const notReady = !!item && !entry && (item.status !== "ready" || (gate?.blockers.length ?? 0) > 0);
  const others = item ? data.posts.filter((p) => p.premade_post_id === item.id && !p.archived_at && (!entry?.schedule_group_id || p.schedule_group_id !== entry.schedule_group_id) && p.id !== entry?.id && p.scheduled_date) : [];
  const otherDates = [...new Set(others.map((p) => p.scheduled_date!))].sort();
  const rhythm = date ? rhythmLabel(data, date) : null;
  const addable = CALENDAR_PLATFORMS.filter((x) => !platforms.includes(x));
  const save = async () => {
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      if (entry) {
        const r = await editScheduleApi(entry.id, legacy ? { date, time: time || null, platform: platforms[0] } : { date, time: time || null, platforms });
        onDone(`Schedule saved${r.added ? `, added ${r.added}` : ""}${r.archived ? `, removed ${r.archived}` : ""}.`);
      } else if (item) {
        const r = await scheduleFromLibraryApi(item.id, { date, time: time || null, platforms, schedule_anyway: anyway });
        onDone(`Scheduled ${item.name} on ${fmtDate(date)} (${r.ids.length} platform${r.ids.length === 1 ? "" : "s"})`);
      }
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
      setBusy(false);
    }
  };
  const title = entry ? `Edit schedule: ${entryName(data, entry)}` : item && premadeId ? `Add to calendar: ${item.name}` : "New post";
  return (
    <Dialog title={title} onClose={onClose} wide>
      <div className="space-y-3 text-black" data-testid="schedule-dialog">
        <ErrorSummary message={message} errors={errors} />
        {!entry && !premadeId && (
          <div className="space-y-1">
            <label htmlFor="f-sch-search" className="text-xs font-medium">Library post</label>
            <input id="f-sch-search" placeholder="Search by name or caption" value={q} onChange={(e) => setQ(e.target.value)} className={input} autoFocus />
            <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-zinc-200 p-1" role="listbox" aria-label="Library posts" data-testid="schedule-post-list">
              {list.length === 0 && <li className="p-2 text-xs">Nothing matches.</li>}
              {list.map((p) => (
                <li key={p.id} role="option" aria-selected={pickedId === p.id} aria-disabled={p.status === "paused"}>
                  <button
                    type="button"
                    disabled={p.status === "paused"}
                    onClick={() => { setPickedId(p.id); setAnyway(false); }}
                    className={`w-full rounded px-2 py-1.5 text-left text-sm ${touch} ${pickedId === p.id ? "bg-emerald-50 ring-1 ring-emerald-400" : "hover:bg-zinc-50"} disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    <PostOption data={data} p={p} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {(item || legacy) && (
          <>
            <fieldset>
              <legend className="mb-1 text-xs font-medium">Platforms{legacy ? "" : " (one calendar entry each)"}</legend>
              <div className="flex flex-wrap items-center gap-2" data-testid="platform-chips">
                {platforms.map((pl) => {
                  const isLocked = locked.some((r) => r.platform === pl);
                  return (
                    <span key={pl} className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-3 py-1 text-sm">
                      {PLATFORM_LABEL[pl] ?? pl}
                      {isLocked ? (
                        <span className="text-[11px]">(Posted)</span>
                      ) : (
                        !legacy && (
                          <button type="button" aria-label={`Remove ${PLATFORM_LABEL[pl] ?? pl}`} className="px-1" onClick={() => setPlatforms((s) => s.filter((x) => x !== pl))}>✕</button>
                        )
                      )}
                    </span>
                  );
                })}
                {legacy ? (
                  <select aria-label="Platform" value={platforms[0]} onChange={(e) => setPlatforms([e.target.value])} className={`${input} w-44`}>
                    {CALENDAR_PLATFORMS.map((x) => <option key={x} value={x}>{PLATFORM_LABEL[x]}</option>)}
                  </select>
                ) : (
                  addable.length > 0 && (
                    <select aria-label="Add platform" value="" onChange={(e) => e.target.value && setPlatforms((s) => [...s, e.target.value])} className={`${input} w-44`}>
                      <option value="">Add platform</option>
                      {addable.map((x) => <option key={x} value={x}>{PLATFORM_LABEL[x]}</option>)}
                    </select>
                  )
                )}
              </div>
              {errors.platforms && <p className={errorBox}>{errors.platforms}</p>}
            </fieldset>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField name="sch-date" label="Date" type="date" value={date} onChange={setDate} required error={errors.date} />
              <TextField name="sch-time" label="Time (optional)" type="time" value={time} onChange={setTime} error={errors.time} />
            </div>
            {locked.length > 0 && <p className="text-xs">Posted entries keep their date and platform.</p>}
            {item?.category === "reel" && item.best_window_text && <p className={infoBox}>Best window for this reel: {item.best_window_text}{item.best_window_why ? ` (${item.best_window_why})` : ""}</p>}
            {rhythm && <p className="text-xs">Rhythm for {dayName(weekdayOf(date))}: {rhythm}</p>}
            {date && (
              <div className="space-y-1">
                {item?.intent === "paid" ? <ScheduleHintLine data={data} date={date} platform="instagram" intent="paid" /> : platforms.map((pl) => <ScheduleHintLine key={pl} data={data} date={date} time={time} platform={pl} />)}
              </div>
            )}
            {otherDates.length > 0 && (
              <p className={infoBox} data-testid="also-scheduled">
                Also scheduled on {otherDates.slice(0, 3).map((d) => `${fmtDate(d)} for ${[...new Set(others.filter((o) => o.scheduled_date === d).map((o) => PLATFORM_LABEL[o.platform] ?? o.platform))].join(", ")}`).join("; ")}
                {otherDates.length > 3 ? ` and ${otherDates.length - 3} more` : ""}
              </p>
            )}
            {notReady && gate && (
              <div className={warnBox} data-testid="schedule-blockers">
                <p className="font-medium">This post isn&apos;t Ready yet:</p>
                <ul className="list-disc pl-4">
                  {item!.status !== "ready" && <li>Its status is {item!.status[0].toUpperCase() + item!.status.slice(1)}.</li>}
                  {gate.blockers.map((b) => <li key={b.key}>{b.message}</li>)}
                </ul>
                <Checkbox name="sch-anyway" label="Schedule anyway" checked={anyway} onChange={setAnyway} />
              </div>
            )}
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} disabled={busy || (!item && !legacy) || !date || platforms.length === 0 || (notReady && !anyway) || item?.status === "paused"} onClick={save}>
            {busy ? "Saving…" : entry ? "Save schedule" : `Schedule${platforms.length > 1 ? ` ${platforms.length} entries` : ""}`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * A calendar entry: its group's platforms, date and time, status, the FINAL
 * caption (live until Posted, then frozen), assets, and Edit schedule, Mark
 * posted, Remove from calendar, Open in Ad Library.
 */
export function EntryPopover({ data, post, onClose, onEdit, onChanged }: { data: MarketingData; post: Post; onClose: () => void; onEdit: () => void; onChanged: (message: string) => void }) {
  const group = groupOf(data, post);
  const view = entryView(data, post, data.premades);
  const premade = post.premade_post_id ? data.premades.find((p) => p.id === post.premade_post_id) ?? null : null;
  const assetIds = premade && post.status !== "posted" ? premade.asset_ids : post.asset_ids.length ? post.asset_ids : premade?.asset_ids ?? [];
  const [marking, setMarking] = useState(false);
  const [link, setLink] = useState("");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged(message);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog title={view.name} onClose={onClose} wide>
      <div className="space-y-3 text-black" data-testid="entry-popover">
        {error && <p className={errorBox} role="alert">{error}</p>}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {group.map((r) => (
            <span key={r.id} className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs">
              {PLATFORM_SHORT[r.platform] ?? r.platform}{r.status === "posted" ? " (Posted)" : ""}
            </span>
          ))}
          <span>{fmtDate(post.scheduled_date)}{post.scheduled_time ? ` at ${post.scheduled_time}` : ""}</span>
          <Chip tone={post.status === "posted" ? "green" : "blue"}>{post.status[0].toUpperCase() + post.status.slice(1)}</Chip>
        </div>
        {!post.premade_post_id && <p className="text-xs">This entry was made before the library and shows what was stored.</p>}
        <details className="rounded-md border border-zinc-200 p-2" open>
          <summary className="cursor-pointer text-xs font-medium">{post.status === "posted" ? "Caption as posted" : "Final caption (what will be posted)"}</summary>
          <p className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap text-xs" data-testid="entry-caption">{view.caption || "(no caption)"}</p>
        </details>
        <div>
          <p className="mb-1 text-xs font-semibold">Assets</p>
          <AssetCards data={data} ids={assetIds} emptyText="No assets attached." />
        </div>
        {post.posted_url && <p className="text-xs">Posted link: <a className="underline" href={post.posted_url} target="_blank" rel="noopener noreferrer">{post.posted_url}</a></p>}
        {marking && (
          <div className={`${card} space-y-2`}>
            <TextField name="posted-url" label="Posted link (optional)" value={link} onChange={setLink} placeholder="https://" />
            <p className="text-[11px]">Marking posted saves today&apos;s date and keeps this caption with the entry, even if the library post changes later.</p>
            <div className="flex justify-end gap-2">
              <button type="button" className={btn} onClick={() => setMarking(false)}>Cancel</button>
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => run(() => markPostedApi(post.id, { posted_url: link.trim() || null }), `Marked ${view.name} posted`)}>Mark posted</button>
            </div>
          </div>
        )}
        {removing && (
          <div className={`${warnBox} flex flex-wrap items-center justify-between gap-2`}>
            <span>Remove {group.filter((r) => r.status !== "posted").length > 1 ? "these entries" : "this entry"} from the calendar? Posted entries stay.</span>
            <span className="flex gap-2">
              <button type="button" className={btn} onClick={() => setRemoving(false)}>Cancel</button>
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => run(() => removeFromCalendarApi(post.id), "Removed from the calendar")}>Remove</button>
            </span>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {post.premade_post_id && <Link className={btn} href={`/growth/marketing?tab=library&item=${post.premade_post_id}`}>Open in Ad Library</Link>}
          {post.status !== "posted" && <button type="button" className={btn} onClick={onEdit}>Edit schedule</button>}
          {post.status !== "posted" && !marking && <button type="button" className={btn} onClick={() => setMarking(true)}>Mark posted</button>}
          {!removing && group.some((r) => r.status !== "posted") && <button type="button" className={btn} onClick={() => setRemoving(true)}>Remove from calendar</button>}
        </div>
      </div>
    </Dialog>
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
