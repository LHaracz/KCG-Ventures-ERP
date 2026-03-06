"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { formatDate } from "@/lib/date";
import { useSupabase } from "@/components/InstantProvider";

type ItemForm = {
  id?: string;
  name: string;
  unit: string;
  cost_per_unit: number | "";
  quantity_on_hand: number | "";
  par_level: number | "";
};

export default function InventoryPage() {
  const { user, supabase } = useSupabase();
  const [items, setItems] = useState<any[]>([]);
  const [adjustments, setAdjustments] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [editing, setEditing] = useState<ItemForm | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [itemSaving, setItemSaving] = useState(false);

  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [adjustmentType, setAdjustmentType] = useState<
    "purchase" | "usage" | "cycle_count" | "correction"
  >("purchase");
  const [countedQty, setCountedQty] = useState<number | "">("");
  const [deltaQty, setDeltaQty] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [adjError, setAdjError] = useState<string | null>(null);
  const [adjSaving, setAdjSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      const [{ data: itemData }, { data: adjData }] = await Promise.all([
        supabase
          .from("inventory_items")
          .select("*")
          .eq("user_id", user.id)
          .order("name", { ascending: true }),
        supabase
          .from("inventory_adjustments")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100),
      ]);
      setItems(itemData || []);
      setAdjustments(adjData || []);
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const handleNewItem = () => {
    setItemError(null);
    setEditing({
      name: "",
      unit: "",
      cost_per_unit: "",
      quantity_on_hand: 0,
      par_level: "",
    });
  };

  const handleEditItem = (item: any) => {
    setItemError(null);
    setEditing({
      id: item.id,
      name: item.name,
      unit: item.unit,
      cost_per_unit: item.cost_per_unit,
      quantity_on_hand: item.quantity_on_hand,
      par_level: item.par_level ?? "",
    });
  };

  const handleItemSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !editing) return;
    setItemSaving(true);
    setItemError(null);
    try {
      const existing = items;
      const duplicate = existing.find(
        (it: any) =>
          it.name.trim().toLowerCase() === editing.name.trim().toLowerCase() &&
          it.id !== editing.id
      );
      if (duplicate) {
        setItemError(
          "An inventory item with this name already exists for your account."
        );
        setItemSaving(false);
        return;
      }

      const payload: any = {
        name: editing.name.trim(),
        unit: editing.unit.trim(),
        cost_per_unit: Number(editing.cost_per_unit || 0),
        quantity_on_hand: Number(editing.quantity_on_hand || 0),
        par_level:
          editing.par_level === "" ? null : Number(editing.par_level),
      };

      if (editing.id) {
        const { error } = await supabase
          .from("inventory_items")
          .update(payload)
          .eq("id", editing.id)
          .eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("inventory_items").insert({
          ...payload,
          last_count_date: null,
          user_id: user.id,
        });
        if (error) throw error;
      }

      const { data: refreshed } = await supabase
        .from("inventory_items")
        .select("*")
        .eq("user_id", user.id)
        .order("name", { ascending: true });
      setItems(refreshed || []);
      setEditing(null);
    } catch (err: any) {
      setItemError(err.message || "Failed to save inventory item.");
    } finally {
      setItemSaving(false);
    }
  };

  const handleAdjustmentSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !selectedItemId) {
      setAdjError("Please choose an inventory item.");
      return;
    }
    const item = items.find((i: any) => i.id === selectedItemId);
    if (!item) {
      setAdjError("Selected item not found.");
      return;
    }

    setAdjSaving(true);
    setAdjError(null);
    try {
      const now = new Date().toISOString();
      let quantity_delta = 0;
      let newOnHand = item.quantity_on_hand;
      let last_count_date: string | null | undefined = item.last_count_date;

      if (adjustmentType === "cycle_count") {
        if (countedQty === "") {
          setAdjError("Enter a counted quantity.");
          setAdjSaving(false);
          return;
        }
        quantity_delta = Number(countedQty) - Number(item.quantity_on_hand);
        newOnHand = Number(countedQty);
        last_count_date = now;
      } else {
        if (deltaQty === "") {
          setAdjError("Enter a quantity delta.");
          setAdjSaving(false);
          return;
        }
        quantity_delta = Number(deltaQty);
        newOnHand = Number(item.quantity_on_hand) + quantity_delta;
      }

      const { error } = await supabase
        .from("inventory_adjustments")
        .insert({
          inventory_item: item.id,
          adjustment_type: adjustmentType,
          quantity_delta,
          note: note || null,
          created_at: now,
          user_id: user.id,
        });
      if (error) throw error;

      const { error: updateError } = await supabase
        .from("inventory_items")
        .update({
          quantity_on_hand: newOnHand,
          last_count_date,
        })
        .eq("id", item.id)
        .eq("user_id", user.id);
      if (updateError) throw updateError;

      const [{ data: refreshedItems }, { data: refreshedAdjustments }] =
        await Promise.all([
          supabase
            .from("inventory_items")
            .select("*")
            .eq("user_id", user.id)
            .order("name", { ascending: true }),
          supabase
            .from("inventory_adjustments")
            .select("*")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .limit(100),
        ]);
      setItems(refreshedItems || []);
      setAdjustments(refreshedAdjustments || []);
      setCountedQty("");
      setDeltaQty("");
      setNote("");
    } catch (err: any) {
      setAdjError(err.message || "Failed to record adjustment.");
    } finally {
      setAdjSaving(false);
    }
  };

  const adjustmentsList = useMemo(
    () =>
      adjustments.map((a: any) => {
        const it = items.find((i: any) => i.id === a.inventory_item);
        return { ...a, itemName: it?.name ?? "Unknown", unit: it?.unit ?? "" };
      }),
    [adjustments, items]
  );

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
              Inventory & Cycle Count
            </h1>
            <p className="text-sm text-zinc-600">
              Manage materials, capture purchases and usage, and run cycle
              counts.
            </p>
          </div>
          <button
            type="button"
            onClick={handleNewItem}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            New Inventory Item
          </button>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Inventory items
              </h2>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {isLoading ? (
                  <p className="text-xs text-zinc-500">Loading items…</p>
                ) : items.length ? (
                  items.map((it: any) => (
                    <div
                      key={it.id}
                      className="flex items-center justify-between rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5"
                    >
                      <div>
                        <div className="text-xs font-medium text-zinc-900">
                          {it.name}
                        </div>
                        <div className="text-[11px] text-zinc-600">
                          {it.quantity_on_hand} {it.unit} on hand · Cost:
                          {` ${it.cost_per_unit} / ${it.unit}`}
                          {it.par_level != null &&
                            ` · Par: ${it.par_level} ${it.unit}`}
                          {it.last_count_date &&
                            ` · Last count: ${formatDate(
                              it.last_count_date
                            )}`}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="text-[11px] text-emerald-700 underline"
                        onClick={() => handleEditItem(it)}
                      >
                        Edit
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-zinc-500">
                    No inventory items yet. Add your first material to start
                    tracking usage and cycle counts.
                  </p>
                )}
              </div>
            </div>

            {editing && (
              <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
                <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                  {editing.id ? "Edit inventory item" : "New inventory item"}
                </h2>
                <form onSubmit={handleItemSubmit} className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block font-medium text-zinc-800">
                        Name
                      </label>
                      <input
                        type="text"
                        required
                        value={editing.name}
                        onChange={(e) =>
                          setEditing({ ...editing, name: e.target.value })
                        }
                        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block font-medium text-zinc-800">
                        Unit (e.g. g, kg, bottle)
                      </label>
                      <input
                        type="text"
                        required
                        value={editing.unit}
                        onChange={(e) =>
                          setEditing({ ...editing, unit: e.target.value })
                        }
                        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block font-medium text-zinc-800">
                        Cost per unit
                      </label>
                      <input
                        type="number"
                        value={editing.cost_per_unit}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            cost_per_unit:
                              e.target.value === ""
                                ? ""
                                : Number(e.target.value),
                          })
                        }
                        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block font-medium text-zinc-800">
                        Quantity on hand
                      </label>
                      <input
                        type="number"
                        value={editing.quantity_on_hand}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            quantity_on_hand:
                              e.target.value === ""
                                ? ""
                                : Number(e.target.value),
                          })
                        }
                        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block font-medium text-zinc-800">
                        Par level (optional)
                      </label>
                      <input
                        type="number"
                        value={editing.par_level}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            par_level:
                              e.target.value === ""
                                ? ""
                                : Number(e.target.value),
                          })
                        }
                        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                      />
                    </div>
                  </div>
                  {itemError && (
                    <p className="text-xs text-red-600" role="alert">
                      {itemError}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={itemSaving}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {itemSaving ? "Saving…" : "Save item"}
                    </button>
                    <button
                      type="button"
                      className="text-xs text-zinc-500 underline"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Inventory adjustments
              </h2>
              <form onSubmit={handleAdjustmentSubmit} className="space-y-2">
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Inventory item
                  </label>
                  <select
                    value={selectedItemId}
                    onChange={(e) => setSelectedItemId(e.target.value)}
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                  >
                    <option value="">Select…</option>
                    {items.map((it: any) => (
                      <option key={it.id} value={it.id}>
                        {it.name} ({it.unit})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block font-medium text-zinc-800">
                      Adjustment type
                    </label>
                    <select
                      value={adjustmentType}
                      onChange={(e) =>
                        setAdjustmentType(e.target.value as any)
                      }
                      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                    >
                      <option value="purchase">Purchase</option>
                      <option value="usage">Usage</option>
                      <option value="cycle_count">Cycle count</option>
                      <option value="correction">Correction</option>
                    </select>
                  </div>
                  {adjustmentType === "cycle_count" ? (
                    <div>
                      <label className="mb-1 block font-medium text-zinc-800">
                        Counted quantity
                      </label>
                      <input
                        type="number"
                        value={countedQty}
                        onChange={(e) =>
                          setCountedQty(
                            e.target.value === ""
                              ? ""
                              : Number(e.target.value),
                          )
                        }
                        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                      />
                      <p className="mt-1 text-[11px] text-zinc-500">
                        We will compute the delta from the current on-hand
                        quantity.
                      </p>
                    </div>
                  ) : (
                    <div>
                      <label className="mb-1 block font-medium text-zinc-800">
                        Quantity delta
                      </label>
                      <input
                        type="number"
                        value={deltaQty}
                        onChange={(e) =>
                          setDeltaQty(
                            e.target.value === ""
                              ? ""
                              : Number(e.target.value),
                          )
                        }
                        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                      />
                      <p className="mt-1 text-[11px] text-zinc-500">
                        Positive values increase on-hand; negative values
                        decrease on-hand.
                      </p>
                    </div>
                  )}
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Note (optional)
                  </label>
                  <textarea
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                  />
                </div>
                {adjError && (
                  <p className="text-xs text-red-600" role="alert">
                    {adjError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={adjSaving}
                  className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {adjSaving ? "Saving…" : "Save adjustment"}
                </button>
              </form>
            </div>

            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Recent adjustments
              </h2>
              {adjustmentsList.length ? (
                <div className="max-h-64 overflow-y-auto">
                  <table className="min-w-full border-collapse text-left">
                    <thead className="bg-zinc-50 text-[11px] text-zinc-600">
                      <tr>
                        <th className="px-2 py-1 font-medium">Item</th>
                        <th className="px-2 py-1 font-medium">Type</th>
                        <th className="px-2 py-1 font-medium">Delta</th>
                        <th className="px-2 py-1 font-medium">Note</th>
                        <th className="px-2 py-1 font-medium">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adjustmentsList.map((a: any) => (
                        <tr key={a.id} className="border-b text-[11px]">
                          <td className="px-2 py-1">{a.itemName}</td>
                          <td className="px-2 py-1">{a.adjustment_type}</td>
                          <td className="px-2 py-1">
                            {a.quantity_delta} {a.unit}
                          </td>
                          <td className="px-2 py-1">
                            {a.note ?? ""}
                          </td>
                          <td className="px-2 py-1">
                            {formatDate(a.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-zinc-500">
                  Adjustments will appear here once they are recorded.
                </p>
              )}
            </div>
          </div>
        </section>
      </div>
    </AuthGuard>
  );
}

