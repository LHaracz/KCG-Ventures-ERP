"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import {
  sizedPresets,
  suggestPackage,
  validatePresetMaxPoints,
  type PackagingRuleInput,
} from "@/lib/packagingEngine";
import { useAuthedApi } from "@/lib/useWarehouse";
import { formatNyDate } from "@/lib/nyTime";
import type { PackagingPreview } from "@/lib/packagingPreview";

/**
 * Packaging Setup (route kept: /fulfillments/package-presets). Package
 * presets are shared by every logged-in user. Each preset can have "max
 * points"; each BotanIQals product has "points" and an optional smallest
 * allowed package. The packaging engine (src/lib/packagingEngine.ts) uses
 * these to suggest a package for every order.
 */

type PresetForm = {
  id?: string;
  nickname: string;
  length_in: string;
  width_in: string;
  height_in: string;
  tare_weight_oz: string;
  max_points: string;
};

type PresetRow = {
  id: string;
  nickname: string;
  length_in: number;
  width_in: number;
  height_in: number;
  tare_weight_oz: number;
  max_points: number | string | null;
};

type ProductRow = { id: string; name: string };
type RuleDraft = { points: string; minPackageId: string };

const emptyPresetForm: PresetForm = {
  nickname: "",
  length_in: "",
  width_in: "",
  height_in: "",
  tare_weight_oz: "",
  max_points: "",
};

const inputBase =
  "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-black placeholder:text-zinc-600 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";
const inputClassName = `w-full ${inputBase}`;
const primaryButton =
  "rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButton =
  "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60";

const numOrEmpty = (v: number | string | null | undefined) => (v === null || v === undefined ? "" : String(Number(v)));

function friendlyDbError(message: string): string {
  if (/uq_package_presets_max_points|duplicate key/i.test(message)) {
    return "Another package already uses that max points. Each package needs a different max points.";
  }
  if (/max_points_positive/i.test(message)) return "Max points must be a positive number.";
  if (/product_packaging_rules_points_check|points_check/i.test(message)) return "Points must be greater than 0.";
  return message;
}

export default function PackagingSetupPage() {
  const { user, supabase } = useSupabase();
  const api = useAuthedApi();

  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [presetForm, setPresetForm] = useState<PresetForm>(emptyPresetForm);
  const [presetSaving, setPresetSaving] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetMessage, setPresetMessage] = useState<string | null>(null);

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [savedRules, setSavedRules] = useState<Map<string, PackagingRuleInput>>(new Map());
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>({});
  const [rowState, setRowState] = useState<Record<string, { saving?: boolean; error?: string; saved?: boolean }>>({});
  const [rulesError, setRulesError] = useState<string | null>(null);

  // Presets are shared: no user_id filter.
  const loadPresets = async () => {
    const { data, error } = await supabase
      .from("package_presets")
      .select("id, nickname, length_in, width_in, height_in, tare_weight_oz, max_points")
      .order("nickname", { ascending: true });
    if (error) setPresetError(error.message);
    setPresets((data as PresetRow[]) || []);
  };

  const loadRules = async () => {
    const [productsRes, rulesRes] = await Promise.all([
      supabase.from("products").select("id, name").eq("is_microgreen", false).is("deleted_at", null).order("name", { ascending: true }),
      supabase.from("product_packaging_rules").select("product_id, points, min_package_id"),
    ]);
    if (productsRes.error || rulesRes.error) {
      setRulesError(productsRes.error?.message || rulesRes.error?.message || "Failed to load products.");
      return;
    }
    const rows = (productsRes.data as ProductRow[]) || [];
    const ruleMap = new Map<string, PackagingRuleInput>(
      ((rulesRes.data as any[]) || []).map((r) => [
        String(r.product_id),
        { productId: String(r.product_id), points: r.points ?? null, minPackageId: r.min_package_id ?? null },
      ]),
    );
    setProducts(rows);
    setSavedRules(ruleMap);
    setDrafts(
      Object.fromEntries(
        rows.map((p) => {
          const r = ruleMap.get(p.id);
          return [p.id, { points: numOrEmpty(r?.points as any), minPackageId: (r?.minPackageId as string) ?? "" }];
        }),
      ),
    );
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadPresets(), loadRules()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, supabase]);

  const presetInputs = useMemo(
    () => presets.map((p) => ({ id: p.id, nickname: p.nickname, maxPoints: p.max_points })),
    [presets],
  );
  const sized = useMemo(() => sizedPresets(presetInputs), [presetInputs]);

  // --- Presets ---------------------------------------------------------------

  const handlePresetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setPresetError(null);
    setPresetMessage(null);

    const length_in = Number(presetForm.length_in);
    const width_in = Number(presetForm.width_in);
    const height_in = Number(presetForm.height_in);
    const tare_weight_oz = Number(presetForm.tare_weight_oz);
    const maxPointsText = presetForm.max_points.trim();
    const max_points = maxPointsText === "" ? null : Number(maxPointsText);
    if (!presetForm.nickname.trim()) {
      setPresetError("Nickname is required.");
      return;
    }
    if (![length_in, width_in, height_in, tare_weight_oz].every((n) => Number.isFinite(n) && n >= 0)) {
      setPresetError("Dimensions and tare weight must be non-negative numbers.");
      return;
    }
    // Max points: positive and unique among presets (checked here and in the database).
    const after = [
      ...presetInputs.filter((p) => p.id !== presetForm.id),
      { id: presetForm.id ?? "", nickname: presetForm.nickname.trim(), maxPoints: maxPointsText === "" ? null : maxPointsText },
    ];
    const problems = validatePresetMaxPoints(after).filter((p) => p.presetId === (presetForm.id ?? "") || p.presetId === null);
    if (max_points !== null && (!Number.isFinite(max_points) || max_points <= 0)) {
      setPresetError("Max points must be a positive number, or left blank.");
      return;
    }
    if (problems.length > 0) {
      setPresetError(problems[0].message);
      return;
    }

    setPresetSaving(true);
    try {
      const payload = {
        nickname: presetForm.nickname.trim(),
        length_in,
        width_in,
        height_in,
        tare_weight_oz,
        max_points,
      };
      if (presetForm.id) {
        const { error } = await supabase.from("package_presets").update(payload).eq("id", presetForm.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("package_presets").insert({ ...payload, user_id: user.id });
        if (error) throw error;
      }
      await loadPresets();
      setPresetMessage(presetForm.id ? "Package updated." : "Package added.");
      setPresetForm(emptyPresetForm);
    } catch (err: any) {
      setPresetError(friendlyDbError(err.message || "Failed to save package preset."));
    } finally {
      setPresetSaving(false);
    }
  };

  const handleEditPreset = (preset: PresetRow) => {
    setPresetError(null);
    setPresetMessage(null);
    setPresetForm({
      id: preset.id,
      nickname: preset.nickname ?? "",
      length_in: String(preset.length_in ?? ""),
      width_in: String(preset.width_in ?? ""),
      height_in: String(preset.height_in ?? ""),
      tare_weight_oz: String(preset.tare_weight_oz ?? ""),
      max_points: numOrEmpty(preset.max_points),
    });
  };

  // Deleting is blocked by the database while a product rule or an open
  // order's override uses the preset; its message names where.
  const handleDeletePreset = async (id: string) => {
    if (!user) return;
    setPresetError(null);
    setPresetMessage(null);
    try {
      const { error } = await supabase.from("package_presets").delete().eq("id", id);
      if (error) throw error;
      setPresets((prev) => prev.filter((p) => p.id !== id));
      if (presetForm.id === id) setPresetForm(emptyPresetForm);
      setPresetMessage("Package deleted.");
    } catch (err: any) {
      setPresetError(friendlyDbError(err.message || "Failed to delete package preset."));
    }
  };

  // --- Product rules -----------------------------------------------------------

  const draftRules = useMemo(() => {
    const m = new Map<string, PackagingRuleInput>();
    for (const p of products) {
      const d = drafts[p.id];
      if (!d) continue;
      if (d.points.trim() === "" && !d.minPackageId && !savedRules.has(p.id)) continue;
      m.set(p.id, { productId: p.id, points: d.points.trim() === "" ? null : d.points.trim(), minPackageId: d.minPackageId || null });
    }
    return m;
  }, [products, drafts, savedRules]);

  const isDirty = (productId: string) => {
    const d = drafts[productId];
    const r = savedRules.get(productId);
    if (!d) return false;
    return d.points.trim() !== numOrEmpty(r?.points as any) || (d.minPackageId || "") !== ((r?.minPackageId as string) || "");
  };

  const saveRule = async (productId: string) => {
    const d = drafts[productId];
    if (!d) return;
    const pointsText = d.points.trim();
    const points = pointsText === "" ? null : Number(pointsText);
    if (points !== null && (!Number.isFinite(points) || points <= 0)) {
      setRowState((s) => ({ ...s, [productId]: { error: "Points must be greater than 0." } }));
      return;
    }
    setRowState((s) => ({ ...s, [productId]: { saving: true } }));
    const { error } = await supabase
      .from("product_packaging_rules")
      .upsert({ product_id: productId, points, min_package_id: d.minPackageId || null }, { onConflict: "product_id" });
    if (error) {
      setRowState((s) => ({ ...s, [productId]: { error: friendlyDbError(error.message) } }));
      return;
    }
    setSavedRules((m) => new Map(m).set(productId, { productId, points, minPackageId: d.minPackageId || null }));
    setRowState((s) => ({ ...s, [productId]: { saved: true } }));
  };

  // --- Render -------------------------------------------------------------------

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-6 text-black">
        <header>
          <Link href="/fulfillments" className="mb-2 inline-block text-[11px] font-medium text-emerald-800 underline">
            ← Back to Fulfillments
          </Link>
          <h1 className="mb-1 text-2xl font-semibold text-black">Packaging Setup</h1>
          <p className="text-sm text-black">
            Package sizes (shared by everyone) and the points each product takes up. The ERP uses these to suggest a package
            for every order on the Pick List and Shipping Assignments.
          </p>
        </header>

        {/* Package presets ------------------------------------------------------ */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-black">Packages</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <form onSubmit={handlePresetSubmit} className="space-y-2 text-xs">
              <div>
                <label htmlFor="preset-nickname" className="mb-1 block font-medium text-black">
                  Nickname
                </label>
                <input
                  id="preset-nickname"
                  required
                  value={presetForm.nickname}
                  onChange={(e) => setPresetForm((prev) => ({ ...prev, nickname: e.target.value }))}
                  className={inputClassName}
                  placeholder="Small box"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(["length_in", "width_in", "height_in"] as const).map((k) => (
                  <div key={k}>
                    <label htmlFor={`preset-${k}`} className="mb-1 block font-medium text-black">
                      {k === "length_in" ? "L" : k === "width_in" ? "W" : "H"} (in)
                    </label>
                    <input
                      id={`preset-${k}`}
                      required
                      type="number"
                      step="0.01"
                      min="0"
                      value={presetForm[k]}
                      onChange={(e) => setPresetForm((prev) => ({ ...prev, [k]: e.target.value }))}
                      className={inputClassName}
                    />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="preset-tare" className="mb-1 block font-medium text-black">
                    Tare weight (oz)
                  </label>
                  <input
                    id="preset-tare"
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    value={presetForm.tare_weight_oz}
                    onChange={(e) => setPresetForm((prev) => ({ ...prev, tare_weight_oz: e.target.value }))}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label htmlFor="preset-max-points" className="mb-1 block font-medium text-black">
                    Max points
                  </label>
                  <input
                    id="preset-max-points"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={presetForm.max_points}
                    onChange={(e) => setPresetForm((prev) => ({ ...prev, max_points: e.target.value }))}
                    className={inputClassName}
                    placeholder="e.g. 10"
                  />
                </div>
              </div>
              <p className="text-[11px] text-black">
                Max points is how much this package holds. Each package needs a different value; packages are ordered smallest to
                largest by it. Leave it blank to keep a package out of suggestions.
              </p>
              {presetError && (
                <p className="text-xs text-red-700" role="alert">
                  {presetError}
                </p>
              )}
              {presetMessage && (
                <p className="text-xs text-emerald-800" role="status">
                  {presetMessage}
                </p>
              )}
              <div className="flex gap-2">
                <button type="submit" disabled={presetSaving} className={primaryButton}>
                  {presetSaving ? "Saving…" : presetForm.id ? "Update preset" : "Add preset"}
                </button>
                {presetForm.id && (
                  <button type="button" onClick={() => setPresetForm(emptyPresetForm)} className={secondaryButton}>
                    Cancel
                  </button>
                )}
              </div>
            </form>

            <div className="text-xs">
              {loading ? (
                <p className="text-black">Loading…</p>
              ) : presets.length === 0 ? (
                <p className="text-black">No package presets yet.</p>
              ) : (
                <div className="space-y-2">
                  {[...presets]
                    .sort((a, b) => {
                      const am = a.max_points === null ? Infinity : Number(a.max_points);
                      const bm = b.max_points === null ? Infinity : Number(b.max_points);
                      return am - bm || a.nickname.localeCompare(b.nickname);
                    })
                    .map((p) => (
                      <div
                        key={p.id}
                        data-testid={`preset-${p.nickname}`}
                        className={`flex items-center justify-between rounded border px-2 py-1.5 ${
                          p.max_points === null ? "border-amber-300 bg-amber-50" : "border-zinc-100 bg-zinc-50"
                        }`}
                      >
                        <div>
                          <div className="font-medium text-black">{p.nickname}</div>
                          <div className="text-[11px] text-black">
                            {p.length_in}×{p.width_in}×{p.height_in} in · {p.tare_weight_oz} oz tare ·{" "}
                            {p.max_points === null ? (
                              <span className="font-medium">⚠ Set max points to use this package</span>
                            ) : (
                              <span className="font-medium">max {Number(p.max_points)} points</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => handleEditPreset(p)} className="text-[11px] font-medium text-emerald-800 underline">
                            Edit
                          </button>
                          <button type="button" onClick={() => handleDeletePreset(p.id)} className="text-[11px] font-medium text-red-700 underline">
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Product packaging rules ------------------------------------------------ */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-1 text-sm font-semibold text-black">Product packaging rules</h2>
          <p className="mb-3 text-xs text-black">
            Every active BotanIQals product. Points: how much room one unit takes. Smallest allowed package: the product never
            ships in anything smaller. Save each row after changing it.
          </p>
          {rulesError && (
            <p className="mb-2 text-xs text-red-700" role="alert">
              {rulesError}
            </p>
          )}
          {loading ? (
            <p className="text-xs text-black">Loading…</p>
          ) : products.length === 0 ? (
            <p className="text-xs text-black">No active BotanIQals products found in Products &amp; BOM.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs text-black">
                <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-black">
                  <tr>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium">Points</th>
                    <th className="px-3 py-2 font-medium">Smallest allowed package</th>
                    <th className="px-3 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => {
                    const d = drafts[p.id] ?? { points: "", minPackageId: "" };
                    const saved = savedRules.get(p.id);
                    const notSet = !saved || saved.points === null || saved.points === undefined;
                    const st = rowState[p.id] ?? {};
                    const dirty = isDirty(p.id);
                    const minIsUnusable = !!d.minPackageId && !sized.some((s) => s.id === d.minPackageId);
                    return (
                      <tr key={p.id} data-testid={`rule-${p.name}`} className={`border-b border-zinc-100 align-top ${notSet ? "bg-amber-50" : ""}`}>
                        <td className="px-3 py-2">
                          <div className="font-medium">{p.name}</div>
                          {notSet && <div className="text-[11px]">Not set: orders with this product go to Needs Review</div>}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            step="0.01"
                            min="0.01"
                            aria-label={`Points for ${p.name}`}
                            value={d.points}
                            onChange={(e) => {
                              setDrafts((s) => ({ ...s, [p.id]: { ...d, points: e.target.value } }));
                              setRowState((s) => ({ ...s, [p.id]: {} }));
                            }}
                            className={`${inputBase} w-24`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <select
                            aria-label={`Smallest allowed package for ${p.name}`}
                            value={d.minPackageId}
                            onChange={(e) => {
                              setDrafts((s) => ({ ...s, [p.id]: { ...d, minPackageId: e.target.value } }));
                              setRowState((s) => ({ ...s, [p.id]: {} }));
                            }}
                            className={`${inputBase} w-56 max-w-full`}
                          >
                            <option value="">Any package</option>
                            {sized.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.nickname} ({s.maxPoints.toString()} pts)
                              </option>
                            ))}
                            {minIsUnusable && <option value={d.minPackageId}>(package without max points)</option>}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <button type="button" className={primaryButton} disabled={!dirty || st.saving} onClick={() => saveRule(p.id)}>
                              {st.saving ? "Saving…" : "Save"}
                            </button>
                            {st.saved && !dirty && <span className="text-[11px] text-emerald-800">Saved</span>}
                            {st.error && (
                              <span className="text-[11px] text-red-700" role="alert">
                                {st.error}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <TestPanel products={products} rules={draftRules} presetInputs={presetInputs} />

        <PreviewPanel api={api} />
      </div>
    </AuthGuard>
  );
}

function TestPanel({
  products,
  rules,
  presetInputs,
}: {
  products: ProductRow[];
  rules: Map<string, PackagingRuleInput>;
  presetInputs: Array<{ id: string; nickname: string; maxPoints: number | string | null }>;
}) {
  const [lines, setLines] = useState<Array<{ productId: string; qty: string }>>([{ productId: "", qty: "1" }]);
  const components = lines
    .filter((l) => l.productId && Number(l.qty) > 0)
    .map((l) => ({
      productId: l.productId,
      productName: products.find((p) => p.id === l.productId)?.name ?? "Unknown product",
      qty: Number(l.qty),
    }));
  const result = components.length
    ? suggestPackage({ components, unmappedLineItems: [], rules, presets: presetInputs })
    : null;

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm" aria-label="Test panel">
      <h2 className="mb-1 text-sm font-semibold text-black">Test panel</h2>
      <p className="mb-3 text-xs text-black">Pick products and quantities to see what package an order would get. Uses the values in the table above, including unsaved changes.</p>
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`Test product ${i + 1}`}
              value={l.productId}
              onChange={(e) => setLines((s) => s.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}
              className={`${inputBase} w-72 max-w-full text-xs`}
            >
              <option value="">Choose a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="1"
              step="1"
              aria-label={`Test quantity ${i + 1}`}
              value={l.qty}
              onChange={(e) => setLines((s) => s.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
              className={`${inputBase} w-20 text-xs`}
            />
            {lines.length > 1 && (
              <button type="button" className={secondaryButton} onClick={() => setLines((s) => s.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
        ))}
        <button type="button" className={secondaryButton} onClick={() => setLines((s) => [...s, { productId: "", qty: "1" }])}>
          Add product
        </button>
      </div>
      {result && (
        <div className="mt-4 rounded-md bg-zinc-50 p-3 text-xs text-black" data-testid="test-result">
          <p className="text-sm">
            <strong>{result.status === "suggested" ? result.presetName : "Needs Review"}</strong> · {result.totalPoints} points
          </p>
          <p className="mt-1">{result.reason}</p>
          <table className="mt-2 min-w-[20rem] text-left">
            <thead>
              <tr>
                <th className="pr-4 font-medium">Product</th>
                <th className="pr-4 font-medium">Qty</th>
                <th className="pr-4 font-medium">Points each</th>
                <th className="pr-4 font-medium">Subtotal</th>
                <th className="font-medium">Minimum</th>
              </tr>
            </thead>
            <tbody>
              {result.breakdown.map((b) => (
                <tr key={b.productId}>
                  <td className="pr-4">{b.productName}</td>
                  <td className="pr-4">{b.qty}</td>
                  <td className="pr-4">{b.pointsEach ?? "Not set"}</td>
                  <td className="pr-4">{b.subtotal ?? "—"}</td>
                  <td>{b.minPackageName ?? "Any"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PreviewPanel({ api }: { api: ReturnType<typeof useAuthedApi> }) {
  const [preview, setPreview] = useState<(PackagingPreview & { since: string }) | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setPreview(await api<PackagingPreview & { since: string }>("/api/fulfillments/packaging-preview"));
    } catch (err: any) {
      setError(err.message || "Couldn't run the preview.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm" aria-label="Last 90 days preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-black">Last 90 days preview</h2>
          <p className="text-xs text-black">
            Runs the current saved rules over the last 90 days of imported orders (every channel except POS). Read-only.
          </p>
        </div>
        <button type="button" className={primaryButton} onClick={run} disabled={running}>
          {running ? "Running…" : preview ? "Run again" : "Run preview"}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <div className="mt-4 space-y-4 text-xs text-black" data-testid="preview-result">
          <p>
            {preview.orderCount} orders since {formatNyDate(preview.since)}.
          </p>
          <div className="flex flex-wrap gap-2">
            {preview.packages.map((p) => (
              <div key={p.presetId} className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2">
                <div className="font-medium">{p.nickname}</div>
                <div className="text-lg font-semibold">{p.count}</div>
              </div>
            ))}
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
              <div className="font-medium">Needs Review</div>
              <div className="text-lg font-semibold">{preview.needsReview}</div>
            </div>
          </div>
          {preview.topReasons.length > 0 && (
            <div>
              <h3 className="mb-1 font-semibold">Top Needs Review reasons</h3>
              <ul className="space-y-2">
                {preview.topReasons.map((r) => (
                  <li key={r.kind}>
                    <span className="font-medium">{r.label}</span>: {r.orders} order{r.orders === 1 ? "" : "s"}
                    {r.subjects.length > 0 && (
                      <span> ({r.subjects.map((s) => `${s.name} ×${s.orders}`).join(", ")})</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
