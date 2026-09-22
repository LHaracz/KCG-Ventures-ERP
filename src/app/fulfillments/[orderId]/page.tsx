"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";

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

  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === selectedPresetId) || null,
    [presets, selectedPresetId],
  );

  const totalParcelWeightOz = useMemo(() => {
    const productWeight = order?.totalProductWeightOz ?? 0;
    const tare = selectedPreset?.tare_weight_oz ?? 0;
    return productWeight + tare;
  }, [order, selectedPreset]);

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
          <h1 className="text-2xl font-semibold text-zinc-900">
            {order ? order.name : "Order"}
          </h1>
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
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="">Select a package…</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nickname} ({p.length_in}×{p.width_in}×{p.height_in} in, {p.tare_weight_oz} oz tare)
                      </option>
                    ))}
                  </select>
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

              {/* TODO (Part 2): once an EasyPost API key is available, add a
                  "Buy Label" button here that rates + purchases a shipping label
                  using the selected package preset's dimensions and
                  totalParcelWeightOz, via a shipping_method_map table that maps
                  this order's shippingMethodTitle to a carrier/service. */}

              {/* TODO (Part 2): add a "Mark Fulfilled" button that calls the
                  Shopify Admin fulfillmentCreate mutation (notifyCustomer: true)
                  once a label has been purchased for this order. */}
            </section>
          </>
        )}
      </div>
    </AuthGuard>
  );
}
