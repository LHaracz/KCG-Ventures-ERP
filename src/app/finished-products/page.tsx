"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";

type InventoryRow = {
  id: string;
  product_name: string;
  qty_on_hand: number;
  reserved_qty: number;
  available_qty: number;
  updated_at: string;
};

export default function FinishedProductsPage() {
  const { user, supabase } = useSupabase();
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const fetchInventory = useCallback(async () => {
    if (!user) return;
    setIsLoading(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        throw new Error("Unable to fetch session token.");
      }

      const response = await fetch("/api/inventory", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const payload = (await response.json()) as { data?: InventoryRow[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load inventory.");
      }
      setRows(payload.data ?? []);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to load inventory.");
      setRows([]);
    } finally {
      setIsLoading(false);
    }
  }, [supabase, user]);

  useEffect(() => {
    fetchInventory();
  }, [fetchInventory]);

  const handleManualSync = async () => {
    if (!user) return;
    setIsSyncing(true);
    setSyncMessage(null);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        throw new Error("Unable to fetch session token.");
      }
      const response = await fetch("/api/inventory/sync", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        synced?: number;
        failed?: Array<{ productId: string; error: string }>;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Manual sync failed.");
      }
      const failedCount = payload.failed?.length ?? 0;
      setSyncMessage(
        failedCount
          ? `Synced ${payload.synced ?? 0} products, ${failedCount} failed.`
          : `Synced ${payload.synced ?? 0} products to Shopify.`,
      );
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Manual sync failed.");
    } finally {
      setIsSyncing(false);
    }
  };

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => a.product_name.localeCompare(b.product_name)),
    [rows],
  );

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">Finished Products Inventory</h1>
            <p className="text-sm text-black">
              BotanIQals inventory source of truth. Shopify inventory mirrors these values.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={fetchInventory}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={handleManualSync}
              disabled={isSyncing}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSyncing ? "Syncing..." : "Sync to Shopify"}
            </button>
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        {syncMessage && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            {syncMessage}
          </div>
        )}

        <section className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full border-collapse text-left">
            <thead className="bg-zinc-50 text-xs text-zinc-700">
              <tr>
                <th className="px-3 py-2 font-medium">Product Name</th>
                <th className="px-3 py-2 font-medium">Qty On Hand</th>
                <th className="px-3 py-2 font-medium">Reserved Qty</th>
                <th className="px-3 py-2 font-medium">Available Qty</th>
                <th className="px-3 py-2 font-medium">Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td className="px-3 py-4 text-sm text-black" colSpan={5}>
                    Loading inventory...
                  </td>
                </tr>
              ) : sortedRows.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-sm text-black" colSpan={5}>
                    No BotanIQals finished product inventory records found.
                  </td>
                </tr>
              ) : (
                sortedRows.map((row) => (
                  <tr key={row.id} className="border-t text-sm text-zinc-900">
                    <td className="px-3 py-2">{row.product_name}</td>
                    <td className="px-3 py-2">{row.qty_on_hand}</td>
                    <td className="px-3 py-2">{row.reserved_qty}</td>
                    <td className="px-3 py-2">{row.available_qty}</td>
                    <td className="px-3 py-2">{new Date(row.updated_at).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      </div>
    </AuthGuard>
  );
}
