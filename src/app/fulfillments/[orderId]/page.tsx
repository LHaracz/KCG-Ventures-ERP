"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import { fulfillmentStatusBadge, type FulfillmentStatus } from "@/lib/fulfillmentStatus";
import type { CanonicalAddress } from "@/lib/fulfillmentOrder";
import type { VariantMapRow } from "@/lib/salesAttribution";
import { buildComponentResolver, resolveOrderComponents } from "@/lib/orderComponents";
import {
  NEEDS_REVIEW_KEY,
  effectivePackage,
  sizedPresets,
  suggestPackage,
  type PackagingOverride,
  type PackagingRuleInput,
} from "@/lib/packagingEngine";
import { Modal, PackageBadge } from "@/components/fulfillment/WarehouseUi";

const inputClassName =
  "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

type EasyPostRateOption = {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
  delivery_days: number | null;
};

type FulfillmentLogRow = {
  tracking_number: string | null;
  carrier: string | null;
  service: string | null;
  label_url: string | null;
};

type FulfillmentOrderDetail = {
  orderId: string;
  name: string;
  createdAt: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  shippingAddress: CanonicalAddress | null;
  shippingMethodTitle: string | null;
  lineItems: Array<{
    // Shopify's combined "product title + variant title" — the exact-match
    // key against variant_component_map.lineitem_name (see
    // src/lib/salesAttribution.ts). Not the same as `title`.
    name: string;
    title: string;
    sku: string | null;
    quantity: number;
    unitWeightOz: number;
    extendedWeightOz: number;
  }>;
  totalProductWeightOz: number;
};

type PackagePreset = {
  id: string;
  nickname: string;
  length_in: number;
  width_in: number;
  height_in: number;
  tare_weight_oz: number;
  max_points: number | string | null;
};

export default function FulfillmentOrderDetailPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = params.orderId;
  const { user, supabase } = useSupabase();

  const [order, setOrder] = useState<FulfillmentOrderDetail | null>(null);
  const [orderLoading, setOrderLoading] = useState(true);
  const [orderError, setOrderError] = useState<string | null>(null);

  const [presets, setPresets] = useState<PackagePreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");

  // Resolves raw Shopify line items into packable components, same
  // variant_component_map/exact-name-match logic the Sales Data page uses
  // (src/lib/salesAttribution.ts) — reused as-is, not reimplemented.
  const [variantMap, setVariantMap] = useState<VariantMapRow[]>([]);
  const [productNamesById, setProductNamesById] = useState<Map<string, string>>(new Map());

  // Packaging (picking build): rules, this order's override and staging box.
  const [packagingRules, setPackagingRules] = useState<PackagingRuleInput[]>([]);
  const [packagingOverride, setPackagingOverride] = useState<PackagingOverride | null>(null);
  const [stagingBoxLabel, setStagingBoxLabel] = useState<string | null>(null);
  const [packagingReloadKey, setPackagingReloadKey] = useState(0);
  const [overrideChoice, setOverrideChoice] = useState<string>("");
  const [packagingBusy, setPackagingBusy] = useState(false);
  const [packagingError, setPackagingError] = useState<string | null>(null);
  const [returnConfirmOpen, setReturnConfirmOpen] = useState(false);
  const [presetTouched, setPresetTouched] = useState(false);

  const [status, setStatus] = useState<FulfillmentStatus>("preparing_shipment");
  const [fulfillmentLog, setFulfillmentLog] = useState<FulfillmentLogRow | null>(null);

  // Editable shipping address (direct Shopify write via update-address route).
  const [addressDraft, setAddressDraft] = useState<{
    address1: string;
    address2: string;
    city: string;
    province: string;
    zip: string;
    country: string;
  } | null>(null);
  const [addressSaving, setAddressSaving] = useState(false);
  const [addressSaveError, setAddressSaveError] = useState<string | null>(null);
  const [addressSaved, setAddressSaved] = useState(false);

  // Manual Order Flagging.
  const [isFlagged, setIsFlagged] = useState(false);
  const [flaggedReason, setFlaggedReason] = useState<string | null>(null);
  const [flaggedAt, setFlaggedAt] = useState<string | null>(null);
  const [flaggedBy, setFlaggedBy] = useState<string | null>(null);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [flagReasonDraft, setFlagReasonDraft] = useState("");
  const [flagSubmitting, setFlagSubmitting] = useState(false);
  const [flagError, setFlagError] = useState<string | null>(null);
  const [unflagConfirming, setUnflagConfirming] = useState(false);
  const [unflagSubmitting, setUnflagSubmitting] = useState(false);

  const [printingLabel, setPrintingLabel] = useState(false);
  const [voidingLabel, setVoidingLabel] = useState(false);
  const [voidLabelError, setVoidLabelError] = useState<string | null>(null);
  const [markingFulfilled, setMarkingFulfilled] = useState(false);
  const [markFulfilledError, setMarkFulfilledError] = useState<string | null>(null);

  // Generate Label popup state (Part 2b). Never buys anything until the
  // employee confirms both dropdowns inside the popup.
  const [modalOpen, setModalOpen] = useState(false);
  const [modalRates, setModalRates] = useState<EasyPostRateOption[]>([]);
  const [modalShipmentId, setModalShipmentId] = useState<string | null>(null);
  const [modalSelectedRateId, setModalSelectedRateId] = useState<string | null>(null);
  const [modalUserTouchedRate, setModalUserTouchedRate] = useState(false);
  const [modalQuoting, setModalQuoting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalBuying, setModalBuying] = useState(false);

  useEffect(() => {
    if (!user || !orderId) return;
    let cancelled = false;
    const load = async () => {
      setOrderLoading(true);
      setOrderError(null);
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) throw new Error("Unable to verify your session.");
        const response = await fetch(`/api/fulfillments/${orderId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = (await response.json()) as {
          order?: FulfillmentOrderDetail;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || "Failed to load this order.");
        }
        if (!cancelled) setOrder(payload.order || null);
      } catch (err: any) {
        if (!cancelled) setOrderError(err.message || "Failed to load this order.");
      } finally {
        if (!cancelled) setOrderLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [user, supabase, orderId]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const loadPresets = async () => {
      // Package presets are shared by every logged-in user.
      const { data } = await supabase
        .from("package_presets")
        .select("*")
        .order("nickname", { ascending: true });
      if (!cancelled) setPresets(data || []);
    };
    loadPresets();
    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const loadVariantMapping = async () => {
      const [mapResult, productsResult] = await Promise.all([
        supabase.from("variant_component_map").select("lineitem_name, business, components"),
        supabase.from("products").select("id, name"),
      ]);
      if (cancelled) return;
      if (mapResult.data) setVariantMap(mapResult.data as VariantMapRow[]);
      if (productsResult.data) {
        const rows = productsResult.data as Array<{ id: string; name: string }>;
        setProductNamesById(new Map(rows.map((p) => [p.id, p.name])));
      }
    };
    loadVariantMapping();
    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  useEffect(() => {
    if (!user || !orderId) return;
    let cancelled = false;
    const loadPackaging = async () => {
      const [rulesResult, overrideResult, boxResult] = await Promise.all([
        supabase.from("product_packaging_rules").select("product_id, points, min_package_id"),
        supabase
          .from("order_packaging")
          .select("override_target, override_preset_id, override_preset_name")
          .eq("order_id", orderId)
          .maybeSingle(),
        supabase
          .from("staging_box_assignments")
          .select("staging_boxes(label)")
          .eq("order_id", orderId)
          .is("released_at", null)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      setPackagingRules(
        ((rulesResult.data as any[]) || []).map((r) => ({
          productId: String(r.product_id),
          points: r.points ?? null,
          minPackageId: r.min_package_id ?? null,
        })),
      );
      const o = overrideResult.data as any;
      setPackagingOverride(
        o ? { target: o.override_target, presetId: o.override_preset_id, presetName: o.override_preset_name } : null,
      );
      setStagingBoxLabel(((boxResult.data as any)?.staging_boxes?.label as string | undefined) ?? null);
    };
    loadPackaging();
    return () => {
      cancelled = true;
    };
  }, [user, supabase, orderId, packagingReloadKey]);

  useEffect(() => {
    if (!user || !orderId) return;
    let cancelled = false;
    const loadStatusAndLog = async () => {
      const [statusResult, logResult] = await Promise.all([
        supabase
          .from("order_status")
          .select("status, is_flagged, flagged_reason, flagged_at, flagged_by")
          .eq("shopify_order_id", orderId)
          .maybeSingle(),
        supabase
          .from("fulfillment_log")
          .select("tracking_number, carrier, service, label_url")
          .eq("shopify_order_id", orderId)
          .is("voided_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      if (statusResult.data?.status) setStatus(statusResult.data.status as FulfillmentStatus);
      if (statusResult.data) {
        setIsFlagged(!!statusResult.data.is_flagged);
        setFlaggedReason((statusResult.data.flagged_reason as string | null) ?? null);
        setFlaggedAt((statusResult.data.flagged_at as string | null) ?? null);
        setFlaggedBy((statusResult.data.flagged_by as string | null) ?? null);
      }
      if (logResult.data) setFulfillmentLog(logResult.data as FulfillmentLogRow);
    };
    loadStatusAndLog();
    return () => {
      cancelled = true;
    };
  }, [user, supabase, orderId]);

  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === selectedPresetId) || null,
    [presets, selectedPresetId],
  );

  const totalParcelWeightOz = useMemo(() => {
    const productWeight = order?.totalProductWeightOz ?? 0;
    const tare = selectedPreset?.tare_weight_oz ?? 0;
    return productWeight + tare;
  }, [order, selectedPreset]);

  // Resolves each raw Shopify line item into its real packable components
  // for the Line Items table, so an employee packs actual products instead
  // of an ambiguous bundle name. Weight is NOT recomputed per component —
  // Shopify's own per-line-item weight (unitWeightOz/extendedWeightOz,
  // already correct) is shown once per line item, matching how the order's
  // Total Product Weight is already calculated server-side.
  // One shared resolver (src/lib/orderComponents.ts) used by every
  // fulfillment screen, so the Pick List and this page always agree.
  const componentResolver = useMemo(
    () =>
      buildComponentResolver(
        variantMap,
        Array.from(productNamesById.entries()).map(([id, name]) => ({ id, name })),
      ),
    [variantMap, productNamesById],
  );

  const resolvedOrder = useMemo(
    () => (order ? resolveOrderComponents(order.lineItems, componentResolver) : null),
    [order, componentResolver],
  );
  const resolvedLineItems = useMemo(() => resolvedOrder?.lineItems ?? [], [resolvedOrder]);

  // Effective package: the override if one exists, otherwise the live
  // suggestion from the packaging engine.
  const presetInputs = useMemo(
    () => presets.map((p) => ({ id: p.id, nickname: p.nickname, maxPoints: p.max_points })),
    [presets],
  );
  const sizedPresetList = useMemo(() => sizedPresets(presetInputs), [presetInputs]);
  const packaging = useMemo(() => {
    if (!resolvedOrder) return null;
    const suggestion = suggestPackage({
      components: resolvedOrder.components,
      unmappedLineItems: resolvedOrder.unmappedLineItems,
      rules: packagingRules,
      presets: presetInputs,
    });
    return effectivePackage(suggestion, packagingOverride, presetInputs);
  }, [resolvedOrder, packagingRules, presetInputs, packagingOverride]);

  useEffect(() => {
    if (packaging) setOverrideChoice(packaging.key);
  }, [packaging]);

  // Keeps the editable address form in sync with whatever Shopify actually
  // has — resets on initial load and again after a successful save (the
  // route echoes back Shopify's own normalized response).
  useEffect(() => {
    if (!order?.shippingAddress) return;
    setAddressDraft({
      address1: order.shippingAddress.address1 ?? "",
      address2: order.shippingAddress.address2 ?? "",
      city: order.shippingAddress.city ?? "",
      province: order.shippingAddress.province ?? "",
      zip: order.shippingAddress.zip ?? "",
      country: order.shippingAddress.country ?? "",
    });
  }, [order]);

  const labelAlreadyPurchased = status === "label_generated" || status === "label_printed";

  const authedFetch = async (path: string, body: unknown) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Unable to verify your session.");
    const response = await fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Request failed.");
    }
    return payload;
  };

  const handleOpenGenerateLabel = () => {
    if (!order) return;
    // Preselect the order's effective package (nothing for Needs Review),
    // unless someone already chose a package on this page. Still editable.
    if (!presetTouched) setSelectedPresetId(packaging?.presetId && packaging.key !== NEEDS_REVIEW_KEY ? packaging.presetId : "");
    setModalOpen(true);
    setModalError(null);
    setModalRates([]);
    setModalShipmentId(null);
    setModalSelectedRateId(null);
    setModalUserTouchedRate(false);
  };

  const closeModal = () => {
    setModalOpen(false);
    setModalError(null);
  };

  // Re-quotes live EasyPost rates whenever the popup opens or the preset
  // selection changes. Never buys anything.
  useEffect(() => {
    if (!modalOpen || !order || !selectedPreset) return;
    let cancelled = false;
    const fetchRates = async () => {
      setModalQuoting(true);
      setModalError(null);
      try {
        const payload = await authedFetch(`/api/fulfillments/${orderId}/rates`, {
          parcel: {
            length_in: selectedPreset.length_in,
            width_in: selectedPreset.width_in,
            height_in: selectedPreset.height_in,
            weight_oz: totalParcelWeightOz,
          },
          shippingAddress: order.shippingAddress,
          shippingMethodTitle: order.shippingMethodTitle,
        });
        if (cancelled) return;
        const rates: EasyPostRateOption[] = payload.rates || [];
        setModalRates(rates);
        setModalShipmentId(payload.easypostShipmentId || null);
        setModalSelectedRateId((prev) => {
          if (!modalUserTouchedRate) return payload.preselectedRateId || null;
          // The employee already picked a rate manually — keep it if it's
          // still on the new quote, otherwise leave it blank. Never guess.
          return rates.some((r) => r.id === prev) ? prev : null;
        });
      } catch (err: any) {
        if (!cancelled) setModalError(err.message || "Failed to fetch shipping rates.");
      } finally {
        if (!cancelled) setModalQuoting(false);
      }
    };
    fetchRates();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, selectedPresetId]);

  const handleModalRateChange = (rateId: string) => {
    setModalSelectedRateId(rateId || null);
    setModalUserTouchedRate(true);
  };

  const handleModalGenerateLabel = async () => {
    if (!modalShipmentId || !modalSelectedRateId) return;
    setModalBuying(true);
    setModalError(null);
    try {
      const payload = await authedFetch(`/api/fulfillments/${orderId}/buy-label`, {
        easypostShipmentId: modalShipmentId,
        rateId: modalSelectedRateId,
      });
      setFulfillmentLog({
        tracking_number: payload.trackingNumber,
        carrier: payload.carrier,
        service: payload.service,
        label_url: payload.labelUrl,
      });
      setStatus("label_generated");
      setModalOpen(false);
    } catch (err: any) {
      setModalError(err.message || "Failed to generate the label.");
    } finally {
      setModalBuying(false);
    }
  };

  const handlePrintLabel = async () => {
    if (!fulfillmentLog?.label_url || !orderId) return;
    setPrintingLabel(true);
    try {
      window.open(fulfillmentLog.label_url, "_blank", "noopener,noreferrer");
      const { error } = await supabase
        .from("order_status")
        .upsert(
          { shopify_order_id: orderId, status: "label_printed", updated_at: new Date().toISOString() },
          { onConflict: "shopify_order_id" },
        );
      if (!error) setStatus("label_printed");
    } finally {
      setPrintingLabel(false);
    }
  };

  const handleVoidLabel = async () => {
    if (!orderId) return;
    setVoidingLabel(true);
    setVoidLabelError(null);
    try {
      const payload = await authedFetch(`/api/fulfillments/${orderId}/void-label`, {});
      setFulfillmentLog(null);
      // Back to Picked if the order still holds a staging box.
      setStatus((payload?.status as FulfillmentStatus) || "preparing_shipment");
    } catch (err: any) {
      setVoidLabelError(err.message || "Failed to void this label.");
    } finally {
      setVoidingLabel(false);
    }
  };

  const handleMarkFulfilled = async () => {
    if (!orderId) return;
    setMarkingFulfilled(true);
    setMarkFulfilledError(null);
    try {
      await authedFetch(`/api/fulfillments/${orderId}/mark-fulfilled`, {});
      setStatus("fulfilled");
      setPackagingReloadKey((k) => k + 1);
    } catch (err: any) {
      setMarkFulfilledError(err.message || "Failed to mark this order fulfilled.");
    } finally {
      setMarkingFulfilled(false);
    }
  };

  // --- Packaging override / return to picking ------------------------------

  const handlePackagingOverride = async (clear: boolean) => {
    if (!orderId || !packaging) return;
    setPackagingBusy(true);
    setPackagingError(null);
    try {
      if (clear) {
        await authedFetch(`/api/fulfillments/${orderId}/packaging`, { action: "clear" });
      } else {
        await authedFetch(`/api/fulfillments/${orderId}/packaging`, {
          action: "set",
          target: overrideChoice === NEEDS_REVIEW_KEY ? "needs_review" : "preset",
          presetId: overrideChoice === NEEDS_REVIEW_KEY ? null : overrideChoice,
          previousLabel: packaging.label,
        });
      }
      setPackagingReloadKey((k) => k + 1);
    } catch (err: any) {
      setPackagingError(err.message || "Couldn't change the package.");
    } finally {
      setPackagingBusy(false);
    }
  };

  const handleReturnToPicking = async () => {
    if (!orderId) return;
    setPackagingBusy(true);
    setPackagingError(null);
    try {
      await authedFetch(`/api/fulfillments/${orderId}/return-to-picking`, {});
      setStatus("preparing_shipment");
      setReturnConfirmOpen(false);
      setPackagingReloadKey((k) => k + 1);
    } catch (err: any) {
      setPackagingError(err.message || "Couldn't return this order to picking.");
    } finally {
      setPackagingBusy(false);
    }
  };

  // --- Editable shipping address ------------------------------------------

  const handleAddressDraftField = (field: keyof NonNullable<typeof addressDraft>, value: string) => {
    setAddressDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
    setAddressSaved(false);
  };

  const handleSaveAddress = async () => {
    if (!orderId || !addressDraft) return;
    if (
      !addressDraft.address1.trim() ||
      !addressDraft.city.trim() ||
      !addressDraft.province.trim() ||
      !addressDraft.zip.trim() ||
      !addressDraft.country.trim()
    ) {
      setAddressSaveError("Street address, city, state, zip, and country are required.");
      return;
    }
    setAddressSaving(true);
    setAddressSaveError(null);
    setAddressSaved(false);
    try {
      const payload = await authedFetch(`/api/fulfillments/${orderId}/update-address`, addressDraft);
      const shippingAddress = payload.shippingAddress as CanonicalAddress | null;
      setOrder((prev) => (prev ? { ...prev, shippingAddress } : prev));
      setAddressSaved(true);
    } catch (err: any) {
      setAddressSaveError(err.message || "Failed to save this address.");
    } finally {
      setAddressSaving(false);
    }
  };

  // --- Manual Order Flagging ------------------------------------------------

  const handleOpenFlagModal = () => {
    setFlagReasonDraft(flaggedReason ?? "");
    setFlagError(null);
    setFlagModalOpen(true);
  };

  const handleCloseFlagModal = () => {
    setFlagModalOpen(false);
    setFlagError(null);
  };

  const handleSubmitFlag = async () => {
    if (!orderId) return;
    const reason = flagReasonDraft.trim();
    if (!reason) {
      setFlagError("A reason is required to flag this order.");
      return;
    }
    setFlagSubmitting(true);
    setFlagError(null);
    try {
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("order_status").upsert(
        {
          shopify_order_id: orderId,
          is_flagged: true,
          flagged_reason: reason,
          flagged_at: nowIso,
          flagged_by: user?.email ?? null,
          updated_at: nowIso,
        },
        { onConflict: "shopify_order_id" },
      );
      if (error) throw new Error(error.message);
      setIsFlagged(true);
      setFlaggedReason(reason);
      setFlaggedAt(nowIso);
      setFlaggedBy(user?.email ?? null);
      setFlagModalOpen(false);
    } catch (err: any) {
      setFlagError(err.message || "Failed to flag this order.");
    } finally {
      setFlagSubmitting(false);
    }
  };

  const handleUnflag = async () => {
    if (!orderId) return;
    setUnflagSubmitting(true);
    try {
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("order_status").upsert(
        {
          shopify_order_id: orderId,
          is_flagged: false,
          flagged_reason: null,
          flagged_at: null,
          flagged_by: null,
          updated_at: nowIso,
        },
        { onConflict: "shopify_order_id" },
      );
      if (!error) {
        setIsFlagged(false);
        setFlaggedReason(null);
        setFlaggedAt(null);
        setFlaggedBy(null);
      }
    } finally {
      setUnflagSubmitting(false);
      setUnflagConfirming(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-4xl space-y-6">
        <section>
          <Link
            href="/fulfillments"
            className="mb-2 inline-block text-[11px] font-medium text-emerald-700 underline"
          >
            ← Back to Fulfillments
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-zinc-900">
                {order ? order.name : "Order"}
              </h1>
              {order && (
                <span className={fulfillmentStatusBadge(status).className}>
                  {fulfillmentStatusBadge(status).label}
                </span>
              )}
            </div>
            {order && (
              <div className="flex flex-wrap items-center gap-2">
                {isFlagged ? (
                  <>
                    <button
                      type="button"
                      onClick={handleOpenFlagModal}
                      className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                    >
                      Edit Reason
                    </button>
                    {unflagConfirming ? (
                      <span className="flex items-center gap-2 text-xs text-zinc-700">
                        Unflag this order?
                        <button
                          type="button"
                          onClick={handleUnflag}
                          disabled={unflagSubmitting}
                          className="rounded-md bg-red-600 px-2 py-1 text-[11px] font-medium text-white shadow-sm hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {unflagSubmitting ? "Unflagging…" : "Yes, unflag"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setUnflagConfirming(false)}
                          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-800 hover:bg-zinc-50"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setUnflagConfirming(true)}
                        className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 shadow-sm hover:bg-red-50"
                      >
                        Unflag Order
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleOpenFlagModal}
                    className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-red-700"
                  >
                    Flag Order
                  </button>
                )}
              </div>
            )}
          </div>
          {order && (
            <p className="text-sm text-black">Placed {formatDate(order.createdAt)}</p>
          )}
          {isFlagged && (
            <div
              className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800"
              role="alert"
            >
              <p className="font-semibold">Flagged: {flaggedReason}</p>
              <p className="mt-0.5 text-red-700">
                {flaggedBy ? `By ${flaggedBy}` : "By an unknown user"}
                {flaggedAt ? ` on ${formatDate(flaggedAt)}` : ""}
              </p>
            </div>
          )}
        </section>

        {orderLoading ? (
          <p className="text-xs text-black">Loading order…</p>
        ) : orderError ? (
          <p className="text-xs text-red-600" role="alert">
            {orderError}
          </p>
        ) : !order ? (
          <p className="text-xs text-black">Order not found.</p>
        ) : (
          <>
            <section className="grid gap-6 md:grid-cols-2">
              <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <h2 className="mb-3 text-sm font-semibold text-zinc-900">Customer</h2>
                <dl className="space-y-1 text-xs text-zinc-700">
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Name</dt>
                    <dd className="text-right">{order.customerName}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Email</dt>
                    <dd className="text-right">{order.customerEmail || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Phone</dt>
                    <dd className="text-right">{order.customerPhone || "—"}</dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-zinc-900">Shipping Address</h2>
                  {status === "fulfilled" && (
                    <span className="text-[11px] text-zinc-500">Locked (fulfilled)</span>
                  )}
                </div>
                {order.shippingAddress && (
                  <p className="mb-2 text-xs text-zinc-500">
                    {order.shippingAddress.name || "—"}
                    {order.shippingAddress.phone ? ` · ${order.shippingAddress.phone}` : ""}
                  </p>
                )}
                {addressDraft ? (
                  <div className="space-y-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        value={addressDraft.address1}
                        onChange={(e) => handleAddressDraftField("address1", e.target.value)}
                        placeholder="Address line 1"
                        disabled={status === "fulfilled"}
                        className={`${inputClassName} sm:col-span-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:opacity-70`}
                      />
                      <input
                        value={addressDraft.address2}
                        onChange={(e) => handleAddressDraftField("address2", e.target.value)}
                        placeholder="Address line 2 (optional)"
                        disabled={status === "fulfilled"}
                        className={`${inputClassName} sm:col-span-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:opacity-70`}
                      />
                      <input
                        value={addressDraft.city}
                        onChange={(e) => handleAddressDraftField("city", e.target.value)}
                        placeholder="City"
                        disabled={status === "fulfilled"}
                        className={`${inputClassName} disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:opacity-70`}
                      />
                      <input
                        value={addressDraft.province}
                        onChange={(e) => handleAddressDraftField("province", e.target.value)}
                        placeholder="State/Province"
                        disabled={status === "fulfilled"}
                        className={`${inputClassName} disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:opacity-70`}
                      />
                      <input
                        value={addressDraft.zip}
                        onChange={(e) => handleAddressDraftField("zip", e.target.value)}
                        placeholder="ZIP"
                        disabled={status === "fulfilled"}
                        className={`${inputClassName} disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:opacity-70`}
                      />
                      <input
                        value={addressDraft.country}
                        onChange={(e) => handleAddressDraftField("country", e.target.value)}
                        placeholder="Country"
                        disabled={status === "fulfilled"}
                        className={`${inputClassName} disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:opacity-70`}
                      />
                    </div>

                    {labelAlreadyPurchased && (
                      <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        A label was already purchased for this order&apos;s previous address.
                        Saving a different address here won&apos;t change that label — void it
                        and generate a new one afterward if the address changed.
                      </p>
                    )}

                    {addressSaveError && (
                      <p className="text-xs text-red-600" role="alert">
                        {addressSaveError}
                      </p>
                    )}
                    {addressSaved && !addressSaveError && (
                      <p className="text-xs font-medium text-emerald-700">Address saved.</p>
                    )}

                    {status !== "fulfilled" && (
                      <button
                        type="button"
                        onClick={handleSaveAddress}
                        disabled={addressSaving}
                        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {addressSaving ? "Saving…" : "Save Address"}
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-black">No shipping address on file.</p>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-zinc-900">Shipping Method</h2>
              <p className="text-xs text-zinc-700">
                {order.shippingMethodTitle || "No shipping method on the order."}
              </p>
              <p className="mt-1 text-[11px] text-zinc-500">
                This is what the customer chose in Shopify — kept here as a reference while
                you confirm the carrier/service in the Generate Label popup.
              </p>
            </section>

            <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-zinc-900">Line Items</h2>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-left text-xs">
                  <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Item</th>
                      <th className="px-3 py-2 font-medium">SKU</th>
                      <th className="px-3 py-2 font-medium">Qty</th>
                      <th className="px-3 py-2 font-medium">Unit Weight</th>
                      <th className="px-3 py-2 font-medium">Extended Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolvedLineItems.map((li, idx) => {
                      if (li.components.length === 0) {
                        // No variant_component_map row for this exact Shopify
                        // line item name yet — show the raw name with a clear
                        // warning rather than silently guessing packing/weight.
                        return (
                          <tr key={`${li.name}-${idx}`} className="border-b border-amber-200 bg-amber-50">
                            <td className="px-3 py-2">
                              <div className="text-zinc-900">{li.name}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-medium text-amber-800">
                                <span>⚠ Unmapped — map this variant before fulfilling</span>
                                <Link
                                  href={`/settings/variant-mapping?lineitem=${encodeURIComponent(li.name)}`}
                                  className="rounded-md bg-amber-500 px-2 py-0.5 text-white shadow-sm hover:bg-amber-600"
                                >
                                  Map this
                                </Link>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-zinc-700">{li.sku || "—"}</td>
                            <td className="px-3 py-2 text-zinc-700">{li.quantity}</td>
                            <td className="px-3 py-2 text-zinc-700">
                              {li.unitWeightOz.toFixed(2)} oz
                            </td>
                            <td className="px-3 py-2 text-zinc-700">
                              {li.extendedWeightOz.toFixed(2)} oz
                            </td>
                          </tr>
                        );
                      }
                      // Mapped — one row per real packable component. Weight
                      // is shown once for the whole original line item (via
                      // rowSpan), not split per component: Shopify's own
                      // per-line-item weight is already correct as a total,
                      // and splitting it would fabricate precision that
                      // doesn't exist per component.
                      return li.components.map((c, cIdx) => (
                        <tr key={`${li.name}-${idx}-${cIdx}`} className="border-b border-zinc-100">
                          <td className="px-3 py-2 text-zinc-900">{c.productName}</td>
                          {cIdx === 0 && (
                            <td
                              className="px-3 py-2 text-zinc-700"
                              rowSpan={li.components.length}
                            >
                              {li.sku || "—"}
                            </td>
                          )}
                          <td className="px-3 py-2 text-zinc-700">{c.qty}</td>
                          {cIdx === 0 && (
                            <>
                              <td
                                className="px-3 py-2 text-zinc-700"
                                rowSpan={li.components.length}
                              >
                                {li.unitWeightOz.toFixed(2)} oz
                              </td>
                              <td
                                className="px-3 py-2 text-zinc-700"
                                rowSpan={li.components.length}
                              >
                                {li.extendedWeightOz.toFixed(2)} oz
                              </td>
                            </>
                          )}
                        </tr>
                      ));
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="px-3 py-2 text-right font-medium text-zinc-900">
                        Total product weight
                      </td>
                      <td className="px-3 py-2 font-medium text-zinc-900">
                        {order.totalProductWeightOz.toFixed(2)} oz
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {packaging && (
              <section
                className="rounded-lg border border-zinc-200 bg-white p-4 text-black shadow-sm"
                aria-label="Packaging"
                data-testid="packaging-card"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-black">Packaging</h2>
                  <span className="text-xs text-black">
                    Staging box:{" "}
                    <strong data-testid="packaging-box">{stagingBoxLabel ?? (status === "preparing_shipment" ? "Not picked yet" : "—")}</strong>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <PackageBadge pkg={packaging} />
                </div>
                <p className="mt-1 text-xs text-black">{packaging.reason}</p>
                {packaging.overridden && (
                  <p className="mt-1 text-xs text-black">
                    Original suggestion: {packaging.suggestionLabel} ({packaging.suggestion.reason})
                  </p>
                )}
                <table className="mt-3 text-left text-xs text-black">
                  <thead>
                    <tr>
                      <th className="pr-4 font-medium">Product</th>
                      <th className="pr-4 font-medium">Qty</th>
                      <th className="pr-4 font-medium">Points each</th>
                      <th className="pr-4 font-medium">Points</th>
                      <th className="font-medium">Smallest allowed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packaging.suggestion.breakdown.map((b) => (
                      <tr key={b.productId}>
                        <td className="pr-4">{b.productName}</td>
                        <td className="pr-4">{b.qty}</td>
                        <td className="pr-4">{b.pointsEach ?? "Not set"}</td>
                        <td className="pr-4">{b.subtotal ?? "—"}</td>
                        <td>{b.minPackageName ?? "Any"}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={3} className="pr-4 pt-1 font-medium">
                        Total
                      </td>
                      <td className="pt-1 font-medium">{packaging.suggestion.totalPoints}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>

                {(status === "picked" || status === "label_generated" || status === "label_printed") && (
                  <div className="mt-4 flex flex-wrap items-end gap-2">
                    <div>
                      <label htmlFor="override-choice" className="mb-1 block text-xs font-medium text-black">
                        Change package
                      </label>
                      <select
                        id="override-choice"
                        value={overrideChoice}
                        onChange={(e) => setOverrideChoice(e.target.value)}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm"
                      >
                        {sizedPresetList.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.nickname}
                          </option>
                        ))}
                        <option value={NEEDS_REVIEW_KEY}>Needs Review</option>
                      </select>
                    </div>
                    <button
                      type="button"
                      disabled={packagingBusy || overrideChoice === packaging.key}
                      onClick={() => handlePackagingOverride(false)}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Save package
                    </button>
                    {packaging.overridden && (
                      <button
                        type="button"
                        disabled={packagingBusy}
                        onClick={() => handlePackagingOverride(true)}
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Clear override
                      </button>
                    )}
                    {status === "picked" && (
                      <button
                        type="button"
                        disabled={packagingBusy}
                        onClick={() => {
                          setPackagingError(null);
                          setReturnConfirmOpen(true);
                        }}
                        className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Return to Picking
                      </button>
                    )}
                  </div>
                )}
                {(status === "label_generated" || status === "label_printed") && (
                  <p className="mt-2 text-[11px] text-black">To return this order to picking, void the label first.</p>
                )}
                {packagingError && (
                  <p className="mt-2 text-xs text-red-700" role="alert">
                    {packagingError}
                  </p>
                )}
              </section>
            )}

            <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-zinc-900">Package</h2>
              {presets.length === 0 ? (
                <p className="text-xs text-black">
                  No package presets yet.{" "}
                  <Link href="/fulfillments" className="font-medium text-emerald-700 underline">
                    Add one on the Fulfillments page
                  </Link>{" "}
                  to compute total parcel weight.
                </p>
              ) : (
                <div className="max-w-xs">
                  <label className="mb-1 block text-xs font-medium text-zinc-800">
                    Package preset
                  </label>
                  <select
                    value={selectedPresetId}
                    onChange={(e) => {
                      setSelectedPresetId(e.target.value);
                      setPresetTouched(true);
                    }}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="">Select a package…</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nickname} ({p.length_in}×{p.width_in}×{p.height_in} in, {p.tare_weight_oz} oz tare)
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-black">
                    This also drives the Generate Label popup — it pre-selects the suggested
                    package (see Packaging above), and you can change it there too.
                  </p>
                </div>
              )}

              <div className="mt-4 rounded-md bg-zinc-50 px-3 py-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Total product weight</span>
                  <span className="text-zinc-800">{order.totalProductWeightOz.toFixed(2)} oz</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Package tare weight</span>
                  <span className="text-zinc-800">
                    {selectedPreset ? selectedPreset.tare_weight_oz.toFixed(2) : "0.00"} oz
                  </span>
                </div>
                <div className="mt-1 flex justify-between border-t border-zinc-200 pt-1 font-medium">
                  <span className="text-zinc-900">Total parcel weight</span>
                  <span className="text-zinc-900">{totalParcelWeightOz.toFixed(2)} oz</span>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {!fulfillmentLog?.label_url ? (
                  <div>
                    <button
                      type="button"
                      onClick={handleOpenGenerateLabel}
                      disabled={presets.length === 0 || status === "preparing_shipment"}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Generate Label
                    </button>
                    {status === "preparing_shipment" ? (
                      <p className="mt-1 text-[11px] text-black">
                        Pick this order first: assign a staging box on the{" "}
                        <Link href="/fulfillments/pick-list" className="font-medium text-emerald-800 underline">
                          Pick List
                        </Link>
                        .
                      </p>
                    ) : presets.length === 0 ? (
                      <p className="mt-1 text-[11px] text-zinc-600">
                        Add a package preset above first.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-md border border-zinc-200 bg-white p-3 text-xs">
                    <p className="font-medium text-zinc-900">
                      {fulfillmentLog.carrier} {fulfillmentLog.service}
                    </p>
                    <p className="text-zinc-600">Tracking: {fulfillmentLog.tracking_number}</p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={handlePrintLabel}
                        disabled={printingLabel}
                        className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {printingLabel ? "Opening…" : "Print Label"}
                      </button>
                      <button
                        type="button"
                        onClick={handleVoidLabel}
                        disabled={voidingLabel || status === "fulfilled"}
                        className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {voidingLabel ? "Voiding…" : "Void Label"}
                      </button>
                    </div>
                    {status === "fulfilled" && (
                      <p className="mt-1 text-[11px] text-zinc-600">
                        This order is already fulfilled in Shopify, so its label can&apos;t be
                        voided from here.
                      </p>
                    )}
                    {voidLabelError && (
                      <p className="mt-1 text-xs text-red-600" role="alert">
                        {voidLabelError}
                      </p>
                    )}
                  </div>
                )}

                {status === "fulfilled" ? (
                  <p className="text-xs font-medium text-emerald-700">
                    This order has been marked fulfilled in Shopify.
                  </p>
                ) : (
                  <div>
                    <button
                      type="button"
                      onClick={handleMarkFulfilled}
                      disabled={status !== "label_printed" || markingFulfilled}
                      className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {markingFulfilled ? "Marking fulfilled…" : "Mark Fulfilled"}
                    </button>
                    {status !== "label_printed" && (
                      <p className="mt-1 text-[11px] text-zinc-600">
                        Print the label first to enable this.
                      </p>
                    )}
                    {markFulfilledError && (
                      <p className="mt-1 text-xs text-red-600" role="alert">
                        {markFulfilledError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {modalOpen && order && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-xl rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">Generate Label</h2>
              <p className="mt-1 text-xs text-zinc-600">
                Confirm the packaging and shipping method below. Nothing is purchased until you
                click Generate Label at the bottom of this popup.
              </p>

              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">
                    Packaging Preset
                  </label>
                  <select
                    value={selectedPresetId}
                    onChange={(e) => {
                      setSelectedPresetId(e.target.value);
                      setPresetTouched(true);
                    }}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="">Select a package…</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nickname} ({p.length_in}×{p.width_in}×{p.height_in} in, {p.tare_weight_oz} oz tare)
                      </option>
                    ))}
                  </select>
                  {packaging && packaging.key !== NEEDS_REVIEW_KEY && packaging.presetId !== selectedPresetId && (
                    <p className="mt-1 text-[11px] text-black" data-testid="suggested-package-note">
                      Suggested: {packaging.label}
                    </p>
                  )}
                  {packaging && packaging.key === NEEDS_REVIEW_KEY && (
                    <p className="mt-1 text-[11px] text-black">
                      Needs Review: {packaging.reason}. Choose the package yourself.
                    </p>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">
                    Shipping Method
                  </label>
                  <select
                    value={modalSelectedRateId ?? ""}
                    onChange={(e) => handleModalRateChange(e.target.value)}
                    disabled={modalQuoting || modalRates.length === 0}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
                  >
                    <option value="">
                      {modalQuoting
                        ? "Fetching rates…"
                        : modalRates.length === 0
                          ? "No rates yet"
                          : "Select a shipping method…"}
                    </option>
                    {modalRates.map((rate) => (
                      <option key={rate.id} value={rate.id}>
                        {rate.carrier} {rate.service} — ${rate.rate}
                        {rate.delivery_days != null ? ` — ${rate.delivery_days} day${rate.delivery_days === 1 ? "" : "s"}` : ""}
                      </option>
                    ))}
                  </select>
                  {!modalQuoting && modalRates.length > 0 && !modalSelectedRateId && (
                    <p className="mt-1 text-[11px] text-zinc-600">
                      No shipping method was pre-selected automatically — pick one to match what
                      the customer chose.
                    </p>
                  )}
                </div>

                {modalError && (
                  <p className="text-xs text-red-600" role="alert">
                    {modalError}
                  </p>
                )}
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleModalGenerateLabel}
                  disabled={!selectedPresetId || !modalSelectedRateId || modalBuying || modalQuoting}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {modalBuying ? "Generating…" : "Generate Label"}
                </button>
              </div>
            </div>
          </div>
        )}

        {returnConfirmOpen && order && (
          <Modal title="Return to picking" onClose={() => setReturnConfirmOpen(false)}>
            <p className="text-sm text-black">
              Return order {order.name} to picking? The items need to go back on the shelves and{" "}
              {stagingBoxLabel ?? "its staging box"} will be freed.
            </p>
            {packagingError && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                {packagingError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReturnConfirmOpen(false)}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={packagingBusy}
                onClick={handleReturnToPicking}
                className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {packagingBusy ? "Returning…" : "Return to picking"}
              </button>
            </div>
          </Modal>
        )}

        {flagModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-xl rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">
                {isFlagged ? "Edit Flag Reason" : "Flag Order"}
              </h2>
              <p className="mt-1 text-xs text-zinc-600">
                A reason is required. This is visible to the whole team on the order list and
                this page.
              </p>

              <div className="mt-4">
                <label className="mb-1 block text-xs font-medium text-zinc-800">Reason</label>
                <textarea
                  value={flagReasonDraft}
                  onChange={(e) => setFlagReasonDraft(e.target.value)}
                  rows={4}
                  placeholder="Why is this order flagged?"
                  className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
                {flagError && (
                  <p className="mt-2 text-xs text-red-600" role="alert">
                    {flagError}
                  </p>
                )}
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCloseFlagModal}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSubmitFlag}
                  disabled={flagSubmitting}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {flagSubmitting ? "Saving…" : isFlagged ? "Save Reason" : "Flag Order"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
