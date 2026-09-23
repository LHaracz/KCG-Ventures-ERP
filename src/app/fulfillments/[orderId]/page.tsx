"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import { fulfillmentStatusBadge, type FulfillmentStatus } from "@/lib/fulfillmentStatus";

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
  shippingAddress: {
    name: string;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    country: string | null;
    phone: string | null;
  } | null;
  shippingMethodTitle: string | null;
  lineItems: Array<{
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

  const [status, setStatus] = useState<FulfillmentStatus>("preparing_shipment");
  const [fulfillmentLog, setFulfillmentLog] = useState<FulfillmentLogRow | null>(null);

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
      const { data } = await supabase
        .from("package_presets")
        .select("*")
        .eq("user_id", user.id)
        .order("nickname", { ascending: true });
      if (!cancelled) setPresets(data || []);
    };
    loadPresets();
    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  useEffect(() => {
    if (!user || !orderId) return;
    let cancelled = false;
    const loadStatusAndLog = async () => {
      const [statusResult, logResult] = await Promise.all([
        supabase
          .from("order_status")
          .select("status")
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

  // "Smallest reasonably-fitting preset" — the app has no per-product
  // dimension data (only weight per line item), so there's no true fit
  // check possible. Read as smallest by volume (L×W×H), a sensible always-
  // visible-and-editable default rather than a real fit calculation.
  const smallestPreset = useMemo(() => {
    if (presets.length === 0) return null;
    return [...presets].sort(
      (a, b) => a.length_in * a.width_in * a.height_in - b.length_in * b.width_in * b.height_in,
    )[0];
  }, [presets]);

  const totalParcelWeightOz = useMemo(() => {
    const productWeight = order?.totalProductWeightOz ?? 0;
    const tare = selectedPreset?.tare_weight_oz ?? 0;
    return productWeight + tare;
  }, [order, selectedPreset]);

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
    if (!selectedPresetId && smallestPreset) setSelectedPresetId(smallestPreset.id);
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
      await authedFetch(`/api/fulfillments/${orderId}/void-label`, {});
      setFulfillmentLog(null);
      setStatus("preparing_shipment");
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
    } catch (err: any) {
      setMarkFulfilledError(err.message || "Failed to mark this order fulfilled.");
    } finally {
      setMarkingFulfilled(false);
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
            <p className="text-sm text-black">Placed {formatDate(order.createdAt)}</p>
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
                <h2 className="mb-3 text-sm font-semibold text-zinc-900">
                  Shipping Address
                </h2>
                {order.shippingAddress ? (
                  <div className="space-y-0.5 text-xs text-zinc-700">
                    {order.shippingAddress.name && <p>{order.shippingAddress.name}</p>}
                    {order.shippingAddress.address1 && (
                      <p>{order.shippingAddress.address1}</p>
                    )}
                    {order.shippingAddress.address2 && (
                      <p>{order.shippingAddress.address2}</p>
                    )}
                    <p>
                      {[
                        order.shippingAddress.city,
                        order.shippingAddress.province,
                        order.shippingAddress.zip,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                    {order.shippingAddress.country && <p>{order.shippingAddress.country}</p>}
                    {order.shippingAddress.phone && <p>{order.shippingAddress.phone}</p>}
                  </div>
                ) : (
                  <p className="text-xs text-black">No shipping address on file.</p>
                )}
                {/* TODO (Part 2): flag addresses that fail carrier address verification,
                    and offer a manual address-edit flow (Shopify orderUpdate mutation)
                    when the customer's address needs correction before a label is bought. */}
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
                    {order.lineItems.map((li, idx) => (
                      <tr key={idx} className="border-b border-zinc-100">
                        <td className="px-3 py-2 text-zinc-900">{li.title}</td>
                        <td className="px-3 py-2 text-zinc-700">{li.sku || "—"}</td>
                        <td className="px-3 py-2 text-zinc-700">{li.quantity}</td>
                        <td className="px-3 py-2 text-zinc-700">
                          {li.unitWeightOz.toFixed(2)} oz
                        </td>
                        <td className="px-3 py-2 text-zinc-700">
                          {li.extendedWeightOz.toFixed(2)} oz
                        </td>
                      </tr>
                    ))}
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
                    onChange={(e) => setSelectedPresetId(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="">Select a package…</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nickname} ({p.length_in}×{p.width_in}×{p.height_in} in, {p.tare_weight_oz} oz tare)
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    This also drives the Generate Label popup — it pre-selects the smallest
                    preset by default, and you can change it there too.
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
                      disabled={presets.length === 0}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Generate Label
                    </button>
                    {presets.length === 0 && (
                      <p className="mt-1 text-[11px] text-zinc-600">
                        Add a package preset above first.
                      </p>
                    )}
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
                    onChange={(e) => setSelectedPresetId(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="">Select a package…</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nickname} ({p.length_in}×{p.width_in}×{p.height_in} in, {p.tare_weight_oz} oz tare)
                      </option>
                    ))}
                  </select>
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
      </div>
    </AuthGuard>
  );
}
