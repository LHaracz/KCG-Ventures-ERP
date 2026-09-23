"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";

// Fixed single-row config id, same pattern as notification_config's CONFIG_ID
// (see src/app/settings/notifications/page.tsx).
const CONFIG_ID = "c0000000-0000-0000-0000-000000000001";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

export default function FulfillmentsSettingsPage() {
  const { user, supabase } = useSupabase();

  const [name, setName] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [country, setCountry] = useState("US");
  const [phone, setPhone] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("fulfillments_settings")
        .select(
          "ship_from_name, ship_from_address1, ship_from_address2, ship_from_city, ship_from_state, ship_from_zip, ship_from_country, ship_from_phone",
        )
        .eq("id", CONFIG_ID)
        .maybeSingle();
      if (!error && data) {
        setName(data.ship_from_name ?? "");
        setAddress1(data.ship_from_address1 ?? "");
        setAddress2(data.ship_from_address2 ?? "");
        setCity(data.ship_from_city ?? "");
        setState(data.ship_from_state ?? "");
        setZip(data.ship_from_zip ?? "");
        setCountry(data.ship_from_country || "US");
        setPhone(data.ship_from_phone ?? "");
      }
      setLoading(false);
    };
    load();
  }, [user, supabase]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await supabase.from("fulfillments_settings").upsert(
        {
          id: CONFIG_ID,
          ship_from_name: name.trim(),
          ship_from_address1: address1.trim(),
          ship_from_address2: address2.trim(),
          ship_from_city: city.trim(),
          ship_from_state: state.trim(),
          ship_from_zip: zip.trim(),
          ship_from_country: country.trim() || "US",
          ship_from_phone: phone.trim(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      if (error) throw error;
      setMessage({ type: "ok", text: "Ship-from address saved." });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : "Failed to save";
      setMessage({ type: "error", text });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <Link
            href="/fulfillments"
            className="mb-2 inline-block text-[11px] font-medium text-emerald-700 underline"
          >
            ← Back to Fulfillments
          </Link>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Fulfillments Settings
          </h1>
          <p className="text-sm text-zinc-600">
            This ship-from address is used for every EasyPost label purchase.
            It must be filled in before Buy Label will work.
          </p>
        </header>

        {loading ? (
          <p className="text-sm text-black">Loading…</p>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-md border border-zinc-200 bg-white p-4 text-xs"
          >
            <div>
              <label className="mb-1 block font-medium text-zinc-800">Ship-from name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="KCG Ventures LLC"
                className={inputClassName}
              />
            </div>
            <div>
              <label className="mb-1 block font-medium text-zinc-800">Address line 1</label>
              <input
                value={address1}
                onChange={(e) => setAddress1(e.target.value)}
                className={inputClassName}
              />
            </div>
            <div>
              <label className="mb-1 block font-medium text-zinc-800">
                Address line 2 (optional)
              </label>
              <input
                value={address2}
                onChange={(e) => setAddress2(e.target.value)}
                className={inputClassName}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block font-medium text-zinc-800">City</label>
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className={inputClassName}
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-zinc-800">State</label>
                <input
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  className={inputClassName}
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-zinc-800">ZIP</label>
                <input
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                  className={inputClassName}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-medium text-zinc-800">Country</label>
                <input
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="US"
                  className={inputClassName}
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-zinc-800">Phone</label>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={inputClassName}
                />
              </div>
            </div>
            {message && (
              <p
                className={message.type === "ok" ? "text-sm text-green-700" : "text-sm text-red-600"}
                role="alert"
              >
                {message.text}
              </p>
            )}
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
          </form>
        )}
      </div>
    </AuthGuard>
  );
}
