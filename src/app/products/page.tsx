"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";

type ProductForm = {
  id?: string;
  name: string;
  unit: string;
  sale_price_per_unit: number | "";
  shelf_life_days: number | "";
  notes: string;
  target_batch_size: number | "";
  target_batch_unit: string;
};

type BomForm = {
  id?: string;
  line_type: "inventory_item" | "raw_microgreen" | "dried_microgreen" | "packaging";
  inventory_item_id: string;
  microgreen_id: string;
  freeze_dryer_profile_id: string;
  qty_per_unit: number | "";
  unit_label: string;
  notes: string;
};

export default function ProductsPage() {
  const { user, supabase } = useSupabase();
  const [products, setProducts] = useState<any[]>([]);
  const [microgreens, setMicrogreens] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [bomLines, setBomLines] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [editing, setEditing] = useState<ProductForm | null>(null);
  const [productError, setProductError] = useState<string | null>(null);
  const [productSaving, setProductSaving] = useState(false);

  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [bomEditing, setBomEditing] = useState<BomForm | null>(null);
  const [bomError, setBomError] = useState<string | null>(null);
  const [bomSaving, setBomSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      const [p, m, i, b, fdp] = await Promise.all([
        supabase
          .from("products")
          .select("*")
          .eq("user_id", user.id)
          .order("name", { ascending: true }),
        supabase
          .from("microgreens")
          .select("*")
          .eq("user_id", user.id)
          .order("name", { ascending: true }),
        supabase
          .from("inventory_items")
          .select("*")
          .eq("user_id", user.id)
          .order("name", { ascending: true }),
        supabase
          .from("bom_lines")
          .select("*")
          .eq("user_id", user.id),
        supabase
          .from("freeze_dryer_profiles")
          .select("*")
          .eq("user_id", user.id)
          .order("name", { ascending: true }),
      ]);
      setProducts(p.data || []);
      setMicrogreens(m.data || []);
      setItems(i.data || []);
      setBomLines(b.data || []);
      setProfiles(fdp.data || []);
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const selectedProduct = products.find((p: any) => p.id === selectedProductId);

  const handleNewProduct = () => {
    setProductError(null);
    setEditing({
      name: "",
      unit: "",
      sale_price_per_unit: "",
      shelf_life_days: "",
      notes: "",
      target_batch_size: "",
      target_batch_unit: "",
    });
  };

  const handleEditProduct = (p: any) => {
    setProductError(null);
    setEditing({
      id: p.id,
      name: p.name,
      unit: p.unit,
      sale_price_per_unit: p.sale_price_per_unit,
      shelf_life_days: p.shelf_life_days ?? "",
      notes: p.notes ?? "",
      target_batch_size: p.target_batch_size ?? "",
      target_batch_unit: p.target_batch_unit ?? "",
    });
  };

  const handleProductSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !editing) return;
    setProductSaving(true);
    setProductError(null);
    try {
      const duplicate = products.find(
        (p: any) =>
          p.name.trim().toLowerCase() === editing.name.trim().toLowerCase() &&
          p.id !== editing.id
      );
      if (duplicate) {
        setProductError(
          "A product with this name already exists for your account."
        );
        setProductSaving(false);
        return;
      }

      const payload: any = {
        name: editing.name.trim(),
        unit: editing.unit.trim(),
        sale_price_per_unit: Number(editing.sale_price_per_unit || 0),
        shelf_life_days:
          editing.shelf_life_days === ""
            ? null
            : Number(editing.shelf_life_days),
        notes: editing.notes || null,
        target_batch_size:
          editing.target_batch_size === ""
            ? null
            : Number(editing.target_batch_size),
        target_batch_unit: editing.target_batch_unit || null,
      };

      if (editing.id) {
        const { error } = await supabase
          .from("products")
          .update(payload)
          .eq("id", editing.id)
          .eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("products")
          .insert({
            ...payload,
            user_id: user.id,
          })
          .select("*");
        if (error) throw error;
        if (data && data[0]) {
          setSelectedProductId(data[0].id);
        }
      }
      const { data: refreshed } = await supabase
        .from("products")
        .select("*")
        .eq("user_id", user.id)
        .order("name", { ascending: true });
      setProducts(refreshed || []);
      setEditing(null);
    } catch (err: any) {
      setProductError(err.message || "Failed to save product.");
    } finally {
      setProductSaving(false);
    }
  };

  const productBomLines = useMemo(
    () =>
      bomLines.filter((b: any) => b.product === selectedProductId).map((b) => {
        const item = items.find((i: any) => i.id === b.inventory_item);
        const mg = microgreens.find((m: any) => m.id === b.microgreen_id);
        const profile = profiles.find(
          (p: any) => p.id === b.freeze_dryer_profile_id
        );
        let materialName = b.material_name_snapshot;
        if (!materialName) {
          if (item) materialName = item.name;
          else if (mg) materialName = mg.name;
        }
        return {
          ...b,
          itemName: materialName ?? "Unknown",
          itemUnit: b.unit_label,
          microgreenName: mg?.name ?? null,
          profileName: profile?.name ?? null,
        };
      }),
    [bomLines, items, microgreens, profiles, selectedProductId]
  );

  const handleNewBom = () => {
    if (!selectedProductId) return;
    setBomError(null);
    setBomEditing({
      line_type: "inventory_item",
      inventory_item_id: "",
      microgreen_id: "",
      freeze_dryer_profile_id: "",
      qty_per_unit: "",
      unit_label: "",
      notes: "",
    });
  };

  const handleBomItemChange = (inventory_item_id: string) => {
    const item = items.find((i: any) => i.id === inventory_item_id);
    setBomEditing((prev) =>
      prev
        ? {
            ...prev,
            line_type: prev.line_type ?? "inventory_item",
            inventory_item_id,
            unit_label: item?.unit ?? "",
          }
        : {
            line_type: "inventory_item",
            inventory_item_id,
            microgreen_id: "",
            freeze_dryer_profile_id: "",
            qty_per_unit: "",
            unit_label: item?.unit ?? "",
            notes: "",
          }
    );
  };

  const handleBomSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !selectedProductId || !bomEditing) return;
    setBomSaving(true);
    setBomError(null);
    try {
      const item =
        bomEditing.line_type === "inventory_item" ||
        bomEditing.line_type === "packaging"
          ? items.find((i: any) => i.id === bomEditing.inventory_item_id)
          : null;
      if (
        (bomEditing.line_type === "inventory_item" ||
          bomEditing.line_type === "packaging") &&
        !item
      ) {
        setBomError("Select an inventory/packaging item.");
        setBomSaving(false);
        return;
      }
      if (item && bomEditing.unit_label.trim() !== item.unit.trim()) {
        setBomError(
          `Unit must match the inventory item's unit exactly (expected '${item.unit}').`
        );
        setBomSaving(false);
        return;
      }
      if (
        (bomEditing.line_type === "raw_microgreen" ||
          bomEditing.line_type === "dried_microgreen") &&
        !bomEditing.microgreen_id
      ) {
        setBomError("Select a microgreen for this BOM line.");
        setBomSaving(false);
        return;
      }
      const payload: any = {
        product: selectedProductId,
        line_type: bomEditing.line_type,
        inventory_item:
          bomEditing.line_type === "inventory_item" ||
          bomEditing.line_type === "packaging"
            ? bomEditing.inventory_item_id || null
            : null,
        microgreen_id:
          bomEditing.line_type === "raw_microgreen" ||
          bomEditing.line_type === "dried_microgreen"
            ? bomEditing.microgreen_id || null
            : null,
        freeze_dryer_profile_id:
          bomEditing.line_type === "dried_microgreen"
            ? bomEditing.freeze_dryer_profile_id || null
            : null,
        qty_per_unit: Number(bomEditing.qty_per_unit || 0),
        unit_label: bomEditing.unit_label.trim(),
        material_name_snapshot: bomEditing.notes
          ? undefined
          : undefined,
        notes: bomEditing.notes || null,
      };

      if (bomEditing.id) {
        const { error } = await supabase
          .from("bom_lines")
          .update(payload)
          .eq("id", bomEditing.id)
          .eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("bom_lines").insert({
          ...payload,
          user_id: user.id,
        });
        if (error) throw error;
      }
      const { data: refreshed } = await supabase
        .from("bom_lines")
        .select("*")
        .eq("user_id", user.id);
      setBomLines(refreshed || []);
      setBomEditing(null);
    } catch (err: any) {
      setBomError(err.message || "Failed to save BOM line.");
    } finally {
      setBomSaving(false);
    }
  };

  const handleBomDelete = async (id: string) => {
    setBomError(null);
    try {
      const { error } = await supabase
        .from("bom_lines")
        .delete()
        .eq("id", id)
        .eq("user_id", user?.id || "");
      if (error) throw error;
      setBomLines((prev) => prev.filter((b) => b.id !== id));
    } catch (err: any) {
      setBomError(err.message || "Failed to delete BOM line.");
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
              Products & BOM
            </h1>
            <p className="text-sm text-zinc-600">
              Define products linked to microgreens and maintain Bills of
              Materials for cost projections.
            </p>
          </div>
          <button
            type="button"
            onClick={handleNewProduct}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            New Product
          </button>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                Products
              </h2>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {isLoading ? (
                  <p className="text-xs text-zinc-500">Loading products…</p>
                ) : products.length ? (
                  products.map((p: any) => {
                    const mg = microgreens.find(
                      (m: any) => m.id === p.microgreen
                    );
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setSelectedProductId(p.id)}
                        className={`flex w-full items-start justify-between rounded border px-2 py-1.5 text-left ${
                          selectedProductId === p.id
                            ? "border-emerald-500 bg-emerald-50"
                            : "border-zinc-100 bg-zinc-50"
                        }`}
                      >
                        <div>
                          <div className="text-xs font-medium text-zinc-900">
                            {p.name}
                          </div>
                          <div className="text-[11px] text-zinc-600">
                            {mg?.name ?? "Unlinked"} · {p.sale_price_per_unit} /
                            {` ${p.unit}`} · Dried: {p.dried_needed_g_per_unit} g
                            {p.fresh_needed_g_per_unit != null &&
                              ` · Fresh: ${p.fresh_needed_g_per_unit} g`}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="text-[11px] text-emerald-700 underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditProduct(p);
                          }}
                        >
                          Edit
                        </button>
                      </button>
                    );
                  })
                ) : (
                  <p className="text-xs text-zinc-500">
                    No products yet. Create your first one to connect microgreen
                    demand to BOMs and cycles.
                  </p>
                )}
              </div>
            </div>

            {editing && (
              <div className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
                <h2 className="mb-2 text-sm font-semibold text-zinc-900">
                  {editing.id ? "Edit product" : "New product"}
                </h2>
                <form onSubmit={handleProductSubmit} className="space-y-2">
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
                        Unit (e.g. bottle, pouch)
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
                        Sale price per unit
                      </label>
                      <input
                        type="number"
                        value={editing.sale_price_per_unit}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            sale_price_per_unit:
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
                        Shelf life (days, optional)
                      </label>
                      <input
                        type="number"
                        value={editing.shelf_life_days}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            shelf_life_days:
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
                        Target batch size (optional)
                      </label>
                      <input
                        type="number"
                        value={editing.target_batch_size}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            target_batch_size:
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
                        Target batch unit (optional)
                      </label>
                      <input
                        type="text"
                        value={editing.target_batch_unit}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            target_batch_unit: e.target.value,
                          })
                        }
                        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-zinc-800">
                      Notes
                    </label>
                    <textarea
                      rows={3}
                      value={editing.notes}
                      onChange={(e) =>
                        setEditing({ ...editing, notes: e.target.value })
                      }
                      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                    />
                  </div>
                  {productError && (
                    <p className="text-xs text-red-600" role="alert">
                      {productError}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={productSaving}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {productSaving ? "Saving…" : "Save product"}
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
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-900">
                  Bill of Materials
                </h2>
                <button
                  type="button"
                  disabled={!selectedProductId}
                  onClick={handleNewBom}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  Add BOM line
                </button>
              </div>
              {!selectedProduct ? (
                <p className="text-xs text-zinc-500">
                  Select a product to view and edit its BOM lines.
                </p>
              ) : (
                <>
                  <p className="mb-2 text-[11px] text-zinc-600">
                    {selectedProduct.name} · {selectedProduct.sale_price_per_unit}
                    {` / ${selectedProduct.unit}`}
                  </p>
                  <table className="min-w-full border-collapse text-left">
                  <thead className="bg-zinc-50 text-[11px] text-zinc-600">
                      <tr>
                      <th className="px-2 py-1 font-medium">Material</th>
                      <th className="px-2 py-1 font-medium">Type</th>
                        <th className="px-2 py-1 font-medium">Qty per unit</th>
                        <th className="px-2 py-1 font-medium">Unit</th>
                      <th className="px-2 py-1 font-medium">Notes</th>
                        <th className="px-2 py-1 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {productBomLines.length ? (
                        productBomLines.map((b: any) => (
                          <tr key={b.id} className="border-b text-[11px]">
                            <td className="px-2 py-1">{b.itemName}</td>
                          <td className="px-2 py-1">{b.line_type}</td>
                            <td className="px-2 py-1">{b.qty_per_unit}</td>
                            <td className="px-2 py-1">{b.unit_label}</td>
                          <td className="px-2 py-1">{b.notes ?? ""}</td>
                            <td className="px-2 py-1">
                              <button
                                type="button"
                                className="mr-2 text-[11px] text-emerald-700 underline"
                                onClick={() =>
                                  setBomEditing({
                                    id: b.id,
                                  line_type: b.line_type,
                                    inventory_item_id: b.inventory_item,
                                  microgreen_id: b.microgreen_id,
                                  freeze_dryer_profile_id:
                                    b.freeze_dryer_profile_id,
                                    qty_per_unit: b.qty_per_unit,
                                    unit_label: b.unit_label,
                                  notes: b.notes ?? "",
                                  })
                                }
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="text-[11px] text-red-600 underline"
                                onClick={() => handleBomDelete(b.id)}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td
                            colSpan={4}
                            className="px-2 py-3 text-center text-[11px] text-zinc-500"
                          >
                            No BOM lines yet. Add ingredients and packaging for
                            this product.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {bomEditing && (
                    <form
                      onSubmit={handleBomSubmit}
                      className="mt-3 space-y-2 rounded-md bg-zinc-50 p-3"
                    >
                      <div className="grid gap-2 sm:grid-cols-3">
                        <div>
                          <label className="mb-1 block font-medium text-zinc-800">
                            Line type
                          </label>
                          <select
                            value={bomEditing.line_type}
                            onChange={(e) =>
                              setBomEditing({
                                ...(bomEditing as BomForm),
                                line_type: e.target
                                  .value as BomForm["line_type"],
                              })
                            }
                            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                          >
                            <option value="inventory_item">Inventory item</option>
                            <option value="raw_microgreen">Raw microgreen</option>
                            <option value="dried_microgreen">
                              Dried microgreen
                            </option>
                            <option value="packaging">Packaging</option>
                          </select>
                          {bomEditing.line_type === "inventory_item" ||
                          bomEditing.line_type === "packaging" ? (
                            <>
                              <label className="mt-2 mb-1 block font-medium text-zinc-800">
                                Inventory / packaging item
                              </label>
                              <select
                                required
                                value={bomEditing.inventory_item_id}
                                onChange={(e) =>
                                  handleBomItemChange(e.target.value)
                                }
                                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                              >
                                <option value="">Select…</option>
                                {items.map((i: any) => (
                                  <option key={i.id} value={i.id}>
                                    {i.name} ({i.unit})
                                  </option>
                                ))}
                              </select>
                            </>
                          ) : (
                            <>
                              <label className="mt-2 mb-1 block font-medium text-zinc-800">
                                Microgreen
                              </label>
                              <select
                                required
                                value={bomEditing.microgreen_id}
                                onChange={(e) =>
                                  setBomEditing({
                                    ...(bomEditing as BomForm),
                                    microgreen_id: e.target.value,
                                  })
                                }
                                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                              >
                                <option value="">Select…</option>
                                {microgreens.map((m: any) => (
                                  <option key={m.id} value={m.id}>
                                    {m.name}
                                  </option>
                                ))}
                              </select>
                              {bomEditing.line_type === "dried_microgreen" && (
                                <>
                                  <label className="mt-2 mb-1 block font-medium text-zinc-800">
                                    Freeze dryer profile (optional)
                                  </label>
                                  <select
                                    value={bomEditing.freeze_dryer_profile_id}
                                    onChange={(e) =>
                                      setBomEditing({
                                        ...(bomEditing as BomForm),
                                        freeze_dryer_profile_id:
                                          e.target.value,
                                      })
                                    }
                                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                                  >
                                    <option value="">None</option>
                                    {profiles.map((p: any) => (
                                      <option key={p.id} value={p.id}>
                                        {p.name}
                                      </option>
                                    ))}
                                  </select>
                                </>
                              )}
                            </>
                          )}
                        </div>
                        <div>
                          <label className="mb-1 block font-medium text-zinc-800">
                            Qty per unit
                          </label>
                          <input
                            type="number"
                            required
                            value={bomEditing.qty_per_unit}
                            onChange={(e) =>
                              setBomEditing({
                                ...(bomEditing as BomForm),
                                qty_per_unit:
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
                            Unit label
                          </label>
                          <input
                            type="text"
                            readOnly
                            value={bomEditing.unit_label}
                            className="w-full rounded-md border border-gray-200 bg-zinc-100 px-2 py-1.5 text-[11px] text-black shadow-inner disabled:text-gray-500"
                          />
                          <p className="mt-1 text-[10px] text-zinc-500">
                            Must match the inventory item's unit exactly. No
                            unit conversions are applied.
                          </p>
                        </div>
                        <div className="sm:col-span-3">
                          <label className="mb-1 block font-medium text-zinc-800">
                            Notes (optional)
                          </label>
                          <textarea
                            rows={2}
                            value={bomEditing.notes}
                            onChange={(e) =>
                              setBomEditing({
                                ...(bomEditing as BomForm),
                                notes: e.target.value,
                              })
                            }
                            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                          />
                        </div>
                      </div>
                      {bomError && (
                        <p className="text-[11px] text-red-600" role="alert">
                          {bomError}
                        </p>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          type="submit"
                          disabled={bomSaving}
                          className="rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {bomSaving ? "Saving…" : "Save BOM line"}
                        </button>
                        <button
                          type="button"
                          className="text-[11px] text-zinc-500 underline"
                          onClick={() => setBomEditing(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </AuthGuard>
  );
}

