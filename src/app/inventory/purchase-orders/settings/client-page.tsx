"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import {
  EMPTY_SHIP_TO_DEFAULT,
  fetchAllCompanyProfiles,
  type CompanyProfile,
  type ShipToDefault,
} from "@/lib/companyProfiles";
import { isAccentColorTooLight } from "@/lib/colorContrast";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
const labelClassName = "mb-1 block text-xs font-medium text-zinc-800";
const sectionHeadingClassName = "text-xs font-semibold uppercase tracking-wide text-zinc-500";

type ProfileDraft = {
  display_name: string;
  legal_name: string;
  po_prefix: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  accent_color: string;
  default_buyer_name: string;
  default_buyer_title: string;
  default_buyer_phone: string;
  default_buyer_email: string;
  default_payment_terms: string;
  default_shipping_method: string;
  default_freight_terms: string;
  default_special_instructions: string;
  default_terms_text: string;
  footer_note: string;
  ship_to_default: ShipToDefault;
};

function draftFromProfile(profile: CompanyProfile): ProfileDraft {
  return {
    display_name: profile.display_name,
    legal_name: profile.legal_name,
    po_prefix: profile.po_prefix,
    address_line1: profile.address_line1 ?? "",
    address_line2: profile.address_line2 ?? "",
    city: profile.city ?? "",
    state: profile.state ?? "",
    zip: profile.zip ?? "",
    country: profile.country ?? "",
    phone: profile.phone ?? "",
    email: profile.email ?? "",
    website: profile.website ?? "",
    accent_color: profile.accent_color,
    default_buyer_name: profile.default_buyer_name ?? "",
    default_buyer_title: profile.default_buyer_title ?? "",
    default_buyer_phone: profile.default_buyer_phone ?? "",
    default_buyer_email: profile.default_buyer_email ?? "",
    default_payment_terms: profile.default_payment_terms ?? "",
    default_shipping_method: profile.default_shipping_method ?? "",
    default_freight_terms: profile.default_freight_terms ?? "",
    default_special_instructions: profile.default_special_instructions ?? "",
    default_terms_text: profile.default_terms_text ?? "",
    footer_note: profile.footer_note ?? "",
    ship_to_default: { ...EMPTY_SHIP_TO_DEFAULT, ...(profile.ship_to_default ?? {}) },
  };
}

function draftToUpdatePayload(draft: ProfileDraft) {
  return {
    display_name: draft.display_name.trim(),
    legal_name: draft.legal_name.trim(),
    po_prefix: draft.po_prefix.trim(),
    address_line1: draft.address_line1.trim() || null,
    address_line2: draft.address_line2.trim() || null,
    city: draft.city.trim() || null,
    state: draft.state.trim() || null,
    zip: draft.zip.trim() || null,
    country: draft.country.trim() || null,
    phone: draft.phone.trim() || null,
    email: draft.email.trim() || null,
    website: draft.website.trim() || null,
    accent_color: draft.accent_color.trim(),
    default_buyer_name: draft.default_buyer_name.trim() || null,
    default_buyer_title: draft.default_buyer_title.trim() || null,
    default_buyer_phone: draft.default_buyer_phone.trim() || null,
    default_buyer_email: draft.default_buyer_email.trim() || null,
    default_payment_terms: draft.default_payment_terms.trim() || null,
    default_shipping_method: draft.default_shipping_method.trim() || null,
    default_freight_terms: draft.default_freight_terms.trim() || null,
    default_special_instructions: draft.default_special_instructions.trim() || null,
    default_terms_text: draft.default_terms_text.trim() || null,
    footer_note: draft.footer_note.trim() || null,
    ship_to_default: draft.ship_to_default,
  };
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className={labelClassName}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClassName}
      />
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  rows = 4,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
}) {
  return (
    <div>
      <label className={labelClassName}>{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={`${inputClassName} font-mono leading-relaxed`}
      />
      {hint && <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}

function LogoUploader({
  profile,
  token,
  onUploaded,
}: {
  profile: CompanyProfile;
  token: string | null;
  onUploaded: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { supabase } = useSupabase();

  useEffect(() => {
    let cancelled = false;
    if (!profile.logo_path || !token) {
      setPreviewUrl(null);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/purchase-orders/company-profiles/${profile.id}/logo-url`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = await res.json();
        if (!cancelled && res.ok) setPreviewUrl(payload.url ?? null);
      } catch {
        // Preview is best-effort; a failed fetch just leaves no preview shown.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.logo_path, profile.id, token]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !token) return;

    setError(null);
    if (file.size > 2 * 1024 * 1024) {
      setError("File exceeds the 2 MB limit.");
      return;
    }
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setError("Only PNG or JPG files are supported.");
      return;
    }

    setUploading(true);
    try {
      const uploadUrlRes = await fetch("/api/purchase-orders/company-profiles/logo-upload-url", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size, mimeType: file.type, profileId: profile.id }),
      });
      const uploadUrlPayload = await uploadUrlRes.json();
      if (!uploadUrlRes.ok) throw new Error(uploadUrlPayload.error || "Could not start the upload.");

      const { path, token: uploadToken } = uploadUrlPayload as { path: string; token: string };
      const { error: uploadError } = await supabase.storage.from("company-assets").uploadToSignedUrl(path, uploadToken, file);
      if (uploadError) throw new Error(uploadError.message || "Failed to upload the logo.");

      const confirmRes = await fetch(`/api/purchase-orders/company-profiles/${profile.id}/logo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const confirmPayload = await confirmRes.json();
      if (!confirmRes.ok) throw new Error(confirmPayload.error || "Failed to save the logo.");

      onUploaded();
    } catch (err: any) {
      setError(err.message || "Failed to upload the logo.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <label className={labelClassName}>Logo</label>
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt={`${profile.display_name} logo`} className="h-full w-full object-contain" />
          ) : (
            <span className="text-[10px] text-zinc-400">No logo</span>
          )}
        </div>
        <div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? "Uploading…" : profile.logo_path ? "Replace logo" : "Upload logo"}
          </button>
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleFileChange} />
          <p className="mt-1 text-[11px] text-zinc-500">PNG or JPG, up to 2 MB.</p>
        </div>
      </div>
      {error && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ProfileCard({
  profile,
  token,
  onChanged,
}: {
  profile: CompanyProfile;
  token: string | null;
  onChanged: () => void;
}) {
  const { supabase } = useSupabase();
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(profile));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    setDraft(draftFromProfile(profile));
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.logo_path]);

  const isDirty = useMemo(() => JSON.stringify(draftToUpdatePayload(draft)) !== JSON.stringify(draftToUpdatePayload(draftFromProfile(profile))), [
    draft,
    profile,
  ]);
  const prefixChanged = draft.po_prefix.trim() !== profile.po_prefix;
  const accentTooLight = isAccentColorTooLight(draft.accent_color || "#000000");
  const validAccentHex = /^#[0-9a-f]{6}$/i.test(draft.accent_color.trim());

  const updateShipTo = (patch: Partial<ShipToDefault>) => setDraft((d) => ({ ...d, ship_to_default: { ...d.ship_to_default, ...patch } }));

  const handleSave = async () => {
    setSaveError(null);
    if (!draft.display_name.trim()) return setSaveError("Business name is required.");
    if (!draft.legal_name.trim()) return setSaveError("Legal name is required.");
    if (!draft.po_prefix.trim()) return setSaveError("PO prefix is required.");
    if (!validAccentHex) return setSaveError("Accent color must be a valid hex color, like #1a472a.");

    setSaving(true);
    try {
      const { error } = await supabase.from("company_profiles").update(draftToUpdatePayload(draft)).eq("id", profile.id);
      if (error) throw new Error(error.message);
      setSaved(true);
      onChanged();
    } catch (err: any) {
      setSaveError(err.message || "Failed to save this business profile.");
    } finally {
      setSaving(false);
    }
  };

  const handleArchiveToggle = async () => {
    setArchiving(true);
    try {
      const { error } = await supabase
        .from("company_profiles")
        .update({ archived_at: profile.archived_at ? null : new Date().toISOString() })
        .eq("id", profile.id);
      if (error) throw new Error(error.message);
      setConfirmArchive(false);
      onChanged();
    } catch (err: any) {
      setSaveError(err.message || "Failed to update this profile's archive status.");
    } finally {
      setArchiving(false);
    }
  };

  return (
    <section className={`rounded-md border bg-white p-4 ${profile.archived_at ? "border-zinc-200 opacity-75" : "border-zinc-200"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-zinc-100 pb-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">
            {profile.display_name}
            {profile.archived_at && (
              <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600">Archived</span>
            )}
          </h2>
          <p className="text-[11px] text-zinc-500">Under {profile.legal_name}</p>
        </div>
        <div className="flex items-center gap-2">
          {saved && !isDirty && <span className="text-[11px] text-emerald-700">Saved</span>}
          <button
            type="button"
            onClick={() => setConfirmArchive(true)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
          >
            {profile.archived_at ? "Restore" : "Archive"}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {saveError && (
        <p className="mt-3 text-xs text-red-600" role="alert">
          {saveError}
        </p>
      )}

      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <p className={sectionHeadingClassName}>Identity</p>
          <Field label="Business name" value={draft.display_name} onChange={(v) => setDraft((d) => ({ ...d, display_name: v }))} />
          <Field label="Legal name (on the PO)" value={draft.legal_name} onChange={(v) => setDraft((d) => ({ ...d, legal_name: v }))} />
          <div>
            <Field label="PO number prefix" value={draft.po_prefix} onChange={(v) => setDraft((d) => ({ ...d, po_prefix: v }))} />
            {prefixChanged && (
              <p className="mt-1 text-[11px] text-amber-700">
                Changing the prefix only affects POs created after you save — existing PO numbers never change.
              </p>
            )}
          </div>
          <LogoUploader profile={profile} token={token} onUploaded={onChanged} />
          <div>
            <label className={labelClassName}>Accent color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={validAccentHex ? draft.accent_color : "#000000"}
                onChange={(e) => setDraft((d) => ({ ...d, accent_color: e.target.value }))}
                className="h-8 w-10 cursor-pointer rounded border border-zinc-300"
              />
              <input
                value={draft.accent_color}
                onChange={(e) => setDraft((d) => ({ ...d, accent_color: e.target.value }))}
                className={`${inputClassName} max-w-[120px] font-mono`}
                placeholder="#1a472a"
              />
            </div>
            {!validAccentHex && <p className="mt-1 text-[11px] text-red-600">Must be a hex color, like #1a472a.</p>}
            {validAccentHex && accentTooLight && (
              <p className="mt-1 text-[11px] text-amber-700">This color is very close to white — it may be hard to see on the PO.</p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <p className={sectionHeadingClassName}>Letterhead address &amp; contact</p>
          <Field label="Address line 1" value={draft.address_line1} onChange={(v) => setDraft((d) => ({ ...d, address_line1: v }))} />
          <Field label="Address line 2" value={draft.address_line2} onChange={(v) => setDraft((d) => ({ ...d, address_line2: v }))} />
          <div className="grid grid-cols-3 gap-2">
            <Field label="City" value={draft.city} onChange={(v) => setDraft((d) => ({ ...d, city: v }))} />
            <Field label="State" value={draft.state} onChange={(v) => setDraft((d) => ({ ...d, state: v }))} />
            <Field label="ZIP" value={draft.zip} onChange={(v) => setDraft((d) => ({ ...d, zip: v }))} />
          </div>
          <Field label="Country" value={draft.country} onChange={(v) => setDraft((d) => ({ ...d, country: v }))} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Phone" value={draft.phone} onChange={(v) => setDraft((d) => ({ ...d, phone: v }))} />
            <Field label="Email" value={draft.email} onChange={(v) => setDraft((d) => ({ ...d, email: v }))} />
          </div>
          <Field label="Website" value={draft.website} onChange={(v) => setDraft((d) => ({ ...d, website: v }))} />
        </div>

        <div className="space-y-3">
          <p className={sectionHeadingClassName}>Default buyer (pre-fills new POs)</p>
          <Field label="Name" value={draft.default_buyer_name} onChange={(v) => setDraft((d) => ({ ...d, default_buyer_name: v }))} />
          <Field label="Title" value={draft.default_buyer_title} onChange={(v) => setDraft((d) => ({ ...d, default_buyer_title: v }))} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Phone" value={draft.default_buyer_phone} onChange={(v) => setDraft((d) => ({ ...d, default_buyer_phone: v }))} />
            <Field label="Email" value={draft.default_buyer_email} onChange={(v) => setDraft((d) => ({ ...d, default_buyer_email: v }))} />
          </div>
          <p className={sectionHeadingClassName}>Default PO terms</p>
          <Field
            label="Payment terms"
            value={draft.default_payment_terms}
            onChange={(v) => setDraft((d) => ({ ...d, default_payment_terms: v }))}
          />
          <Field
            label="Shipping method"
            value={draft.default_shipping_method}
            onChange={(v) => setDraft((d) => ({ ...d, default_shipping_method: v }))}
          />
          <Field
            label="Freight terms"
            value={draft.default_freight_terms}
            onChange={(v) => setDraft((d) => ({ ...d, default_freight_terms: v }))}
          />
        </div>

        <div className="space-y-3">
          <p className={sectionHeadingClassName}>Ship-to default</p>
          <label className="flex items-center gap-1.5 text-xs text-black">
            <input
              type="checkbox"
              checked={draft.ship_to_default.same_as_bill_to}
              onChange={(e) => updateShipTo({ same_as_bill_to: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            Ship to the same address as the letterhead address
          </label>
          {!draft.ship_to_default.same_as_bill_to && (
            <div className="space-y-2 rounded-md border border-zinc-100 bg-zinc-50 p-3">
              <Field label="Ship-to name" value={draft.ship_to_default.name} onChange={(v) => updateShipTo({ name: v })} />
              <Field label="Contact name" value={draft.ship_to_default.contact_name} onChange={(v) => updateShipTo({ contact_name: v })} />
              <Field label="Phone" value={draft.ship_to_default.phone} onChange={(v) => updateShipTo({ phone: v })} />
              <Field label="Address line 1" value={draft.ship_to_default.address_line1} onChange={(v) => updateShipTo({ address_line1: v })} />
              <Field label="Address line 2" value={draft.ship_to_default.address_line2} onChange={(v) => updateShipTo({ address_line2: v })} />
              <div className="grid grid-cols-3 gap-2">
                <Field label="City" value={draft.ship_to_default.city} onChange={(v) => updateShipTo({ city: v })} />
                <Field label="State" value={draft.ship_to_default.state} onChange={(v) => updateShipTo({ state: v })} />
                <Field label="ZIP" value={draft.ship_to_default.zip} onChange={(v) => updateShipTo({ zip: v })} />
              </div>
              <Field label="Country" value={draft.ship_to_default.country} onChange={(v) => updateShipTo({ country: v })} />
              <TextAreaField
                label="Delivery instructions"
                rows={2}
                value={draft.ship_to_default.delivery_instructions}
                onChange={(v) => updateShipTo({ delivery_instructions: v })}
              />
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <TextAreaField
          label="Default special instructions"
          rows={5}
          value={draft.default_special_instructions}
          onChange={(v) => setDraft((d) => ({ ...d, default_special_instructions: v }))}
          hint="Pre-fills new POs for this business; editable per PO."
        />
        <TextAreaField
          label="Terms &amp; conditions"
          rows={7}
          value={draft.default_terms_text}
          onChange={(v) => setDraft((d) => ({ ...d, default_terms_text: v }))}
          hint="Generic starting text — have this reviewed by counsel for your jurisdiction and product category before relying on it. This app does not represent it as legally reviewed."
        />
        <Field label="Footer note (optional)" value={draft.footer_note} onChange={(v) => setDraft((d) => ({ ...d, footer_note: v }))} />
      </div>

      {confirmArchive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-zinc-900">
              {profile.archived_at ? "Restore this business profile?" : "Archive this business profile?"}
            </h2>
            <p className="mt-1 text-xs text-zinc-600">
              {profile.archived_at
                ? `"${profile.display_name}" will be selectable again when creating a new PO.`
                : `"${profile.display_name}" won't be selectable for new POs. Existing POs under it are unaffected — nothing is deleted.`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmArchive(false)}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleArchiveToggle}
                disabled={archiving}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {archiving ? "Saving…" : profile.archived_at ? "Restore" : "Archive"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function NewProfileModal({ token, onCreated, onClose }: { token: string | null; onCreated: () => void; onClose: () => void }) {
  const { supabase } = useSupabase();
  const [displayName, setDisplayName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [poPrefix, setPoPrefix] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!displayName.trim() || !legalName.trim() || !poPrefix.trim()) {
      setError("Business name, legal name, and PO prefix are all required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error: insertError } = await supabase.from("company_profiles").insert({
        display_name: displayName.trim(),
        legal_name: legalName.trim(),
        po_prefix: poPrefix.trim(),
        accent_color: "#1a472a",
        ship_to_default: EMPTY_SHIP_TO_DEFAULT,
      });
      if (insertError) throw new Error(insertError.message);
      onCreated();
    } catch (err: any) {
      setError(err.message || "Failed to create this business profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">New business profile</h2>
        <p className="mt-1 text-xs text-zinc-600">Everything else (address, defaults, logo) can be filled in after it's created.</p>
        <div className="mt-4 space-y-3">
          <Field label="Business name" value={displayName} onChange={setDisplayName} />
          <Field label="Legal name (on the PO)" value={legalName} onChange={setLegalName} />
          <Field label="PO number prefix" value={poPrefix} onChange={setPoPrefix} placeholder="e.g. KCG-PO" />
          {error && (
            <p className="text-xs text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={saving}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PurchaseOrderCompanyProfilesSettingsPage() {
  const { user, supabase } = useSupabase();
  const [profiles, setProfiles] = useState<CompanyProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [showNewProfile, setShowNewProfile] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchAllCompanyProfiles(supabase);
      setProfiles(data);
      const {
        data: { session },
      } = await supabase.auth.getSession();
      setToken(session?.access_token ?? null);
    } catch (err: any) {
      setLoadError(err.message || "Failed to load business profiles.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const activeProfiles = profiles.filter((p) => !p.archived_at);
  const archivedProfiles = profiles.filter((p) => p.archived_at);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Link href="/inventory/purchase-orders" className="mb-1 inline-block text-[11px] font-medium text-emerald-700 underline">
              ← Back to Purchase Orders
            </Link>
            <h1 className="text-2xl font-semibold text-zinc-900">Purchase Order Business Profiles</h1>
            <p className="text-sm text-black">
              Letterhead, defaults, and PO numbering prefix for each business that issues purchase orders.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowNewProfile(true)}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            New business profile
          </button>
        </div>

        {loadError && (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        )}

        {loading ? (
          <p className="text-xs text-black">Loading…</p>
        ) : (
          <div className="space-y-4">
            {activeProfiles.map((profile) => (
              <ProfileCard key={profile.id} profile={profile} token={token} onChanged={load} />
            ))}
            {archivedProfiles.length > 0 && (
              <details className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                <summary className="cursor-pointer text-xs font-medium text-zinc-700">
                  Archived profiles ({archivedProfiles.length})
                </summary>
                <div className="mt-3 space-y-4">
                  {archivedProfiles.map((profile) => (
                    <ProfileCard key={profile.id} profile={profile} token={token} onChanged={load} />
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {showNewProfile && (
          <NewProfileModal
            token={token}
            onClose={() => setShowNewProfile(false)}
            onCreated={() => {
              setShowNewProfile(false);
              load();
            }}
          />
        )}
      </div>
    </AuthGuard>
  );
}
