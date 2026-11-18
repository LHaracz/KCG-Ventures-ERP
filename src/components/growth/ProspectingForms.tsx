"use client";

/**
 * Prospecting forms: the full lead editor, quick add and Log activity.
 * Large touch targets so they work on a phone.
 */
import { useState } from "react";
import { createLeadApi, logActivityApi, updateLeadApi, type GrowthApiError } from "@/lib/growth/client";
import { ACTIVITY_TYPES, DEFAULT_FOLLOW_UP_DAYS, LEAD_CATEGORIES, OUTCOMES } from "@/lib/growth/prospectingConstants";
import { LEAD_STATUSES, LEAD_STATUS_LABEL } from "@/lib/growth/prospecting";
import { addDays, todayNy } from "@/lib/growth/dates";
import type { AssignableEmployee } from "@/lib/growth/employees";
import type { Lead } from "@/lib/growth/prospectingService";
import { Dialog, ErrorSummary, Select, TextArea, TextField, btn, btnPrimary } from "./GrowthUi";

export const categoryLabel = (c: string) => LEAD_CATEGORIES.find((x) => x.value === c)?.label ?? c;
export const outcomeLabel = (o: string | null) => (o ? OUTCOMES.find((x) => x.value === o)?.label ?? o : "");
export const typeLabel = (t: string) => ACTIVITY_TYPES.find((x) => x.value === t)?.label ?? t;
export const STATUS_OPTIONS = LEAD_STATUSES.map((s) => ({ value: s, label: LEAD_STATUS_LABEL[s] }));
export const touch = "min-h-11";

type Draft = Record<string, string>;
const FIELDS = ["name", "category", "status", "address_line1", "address_line2", "city", "state", "zip", "phone", "website_url", "contact_name", "contact_title", "contact_email", "assigned_account_id", "next_follow_up_date", "source", "notes", "lost_reason"] as const;
const toDraft = (l: Lead | null): Draft => Object.fromEntries(FIELDS.map((k) => [k, (l?.[k as keyof Lead] as string | null) ?? (k === "category" ? "other" : k === "status" ? "to_visit" : "")]));

export function LeadEditor({ lead, employees, onClose, onSaved }: { lead: Lead | null; employees: AssignableEmployee[]; onClose: () => void; onSaved: (l: Lead) => void }) {
  const [d, setD] = useState<Draft>(() => toDraft(lead));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (v: string) => setD((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const payload = { ...d, assigned_account_id: d.assigned_account_id || null };
      const res = lead ? await updateLeadApi(lead.id, payload) : await createLeadApi(payload);
      onSaved(res.lead);
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
      setBusy(false);
    }
  };
  const e = (k: string) => errors[k];
  return (
    <Dialog title={lead ? `Edit ${lead.name}` : "Add a store"} onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TextField name="lead-name" label="Store name" value={d.name} onChange={set("name")} required error={e("name")} className="sm:col-span-2" />
          <Select name="lead-category" label="Category" value={d.category} onChange={set("category")} options={LEAD_CATEGORIES} error={e("category")} />
          <Select name="lead-status" label="Status" value={d.status} onChange={set("status")} options={STATUS_OPTIONS} error={e("status")} />
          <Select name="lead-assigned" label="Assigned to" value={d.assigned_account_id} onChange={set("assigned_account_id")} options={[{ value: "", label: "Nobody" }, ...employees.map((x) => ({ value: x.id, label: x.name }))]} />
          <TextField name="lead-follow" label="Next follow-up" type="date" value={d.next_follow_up_date} onChange={set("next_follow_up_date")} error={e("next_follow_up_date")} />
        </div>
        {d.status === "lost" && <TextField name="lead-lost" label="Why lost" value={d.lost_reason} onChange={set("lost_reason")} required error={e("lost_reason")} />}
        <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <legend className="text-xs font-semibold">Address</legend>
          <TextField name="lead-line1" label="Street" value={d.address_line1} onChange={set("address_line1")} error={e("address_line1")} className="sm:col-span-2" />
          <TextField name="lead-line2" label="Suite or unit" value={d.address_line2} onChange={set("address_line2")} error={e("address_line2")} />
          <TextField name="lead-city" label="City" value={d.city} onChange={set("city")} error={e("city")} />
          <TextField name="lead-state" label="State" value={d.state} onChange={set("state")} error={e("state")} />
          <TextField name="lead-zip" label="ZIP" value={d.zip} onChange={set("zip")} error={e("zip")} />
        </fieldset>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TextField name="lead-phone" label="Phone" type="tel" value={d.phone} onChange={set("phone")} error={e("phone")} />
          <TextField name="lead-web" label="Website" value={d.website_url} onChange={set("website_url")} placeholder="https://" error={e("website_url")} />
          <TextField name="lead-source" label="Source" value={d.source} onChange={set("source")} placeholder="Walk-in, referral…" error={e("source")} />
          <TextField name="lead-contact" label="Contact name" value={d.contact_name} onChange={set("contact_name")} error={e("contact_name")} />
          <TextField name="lead-title" label="Contact title" value={d.contact_title} onChange={set("contact_title")} error={e("contact_title")} />
          <TextField name="lead-email" label="Contact email" type="email" value={d.contact_email} onChange={set("contact_email")} error={e("contact_email")} />
        </div>
        <TextArea name="lead-notes" label="Notes" value={d.notes} onChange={set("notes")} error={e("notes")} />
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btn} ${touch}`} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`${btnPrimary} ${touch}`} onClick={save} disabled={busy}>{busy ? "Saving…" : lead ? "Save" : "Add store"}</button>
        </div>
      </div>
    </Dialog>
  );
}

export function LogActivityDialog({
  lead,
  tripStopId,
  defaultType = "visit",
  visitOutcomes,
  onClose,
  onSaved,
}: {
  lead: Pick<Lead, "id" | "name">;
  tripStopId?: string | null;
  defaultType?: string;
  /** Trip stops: offer only the visit outcomes. */
  visitOutcomes?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = todayNy();
  const [d, setD] = useState<Draft>({ activity_date: today, type: defaultType, outcome: "", summary: "", next_step: "", next_follow_up_date: addDays(today, DEFAULT_FOLLOW_UP_DAYS), lost_reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (v: string) => setD((x) => ({ ...x, [k]: v }));
  const outcomes = visitOutcomes ? OUTCOMES.filter((o) => o.value !== "other") : OUTCOMES;
  const save = async () => {
    setBusy(true);
    try {
      await logActivityApi(lead.id, d, tripStopId);
      onSaved();
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Log activity: ${lead.name}`} onClose={onClose}>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <div className="grid grid-cols-2 gap-3">
          <TextField name="act-date" label="Date" type="date" value={d.activity_date} onChange={set("activity_date")} required error={errors.activity_date} />
          <Select name="act-type" label="Type" value={d.type} onChange={set("type")} options={ACTIVITY_TYPES} />
        </div>
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium">Outcome</legend>
          {outcomes.map((o) => (
            <label key={o.value} className={`flex items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm ${touch}`}>
              <input type="radio" name="act-outcome" checked={d.outcome === o.value} onChange={() => set("outcome")(o.value)} className="h-5 w-5" />
              {o.label}
            </label>
          ))}
        </fieldset>
        {d.outcome === "not_interested" && <TextField name="act-lost" label="Why not interested" value={d.lost_reason} onChange={set("lost_reason")} required error={errors.lost_reason} hint="The lead is marked Lost." />}
        {d.outcome === "samples_left" && <p className="text-[11px]">The lead is marked Samples left.</p>}
        <TextArea name="act-summary" label="Summary" value={d.summary} onChange={set("summary")} rows={3} error={errors.summary} />
        <TextField name="act-next" label="Next step" value={d.next_step} onChange={set("next_step")} error={errors.next_step} />
        {d.outcome !== "not_interested" && (
          <TextField name="act-follow" label="Next follow-up" type="date" value={d.next_follow_up_date} onChange={set("next_follow_up_date")} error={errors.next_follow_up_date} hint="Defaults to 7 days from today. Clear it for no follow-up." />
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btn} ${touch}`} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`${btnPrimary} ${touch}`} onClick={save} disabled={busy}>{busy ? "Saving…" : "Log activity"}</button>
        </div>
      </div>
    </Dialog>
  );
}
