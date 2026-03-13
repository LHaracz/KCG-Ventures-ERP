"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";

type MicrogreenForm = {
  id?: string;
  name: string;
  soaking_required: boolean;
  germination_days: number;
  days_to_harvest: number;
  sow_rate_g_per_tray: number;
  notes: string;
  default_soak_offset_days?: number | "";
  light_offset_days?: number | "";
  harvest_offset_days?: number | "";
};

export default function MicrogreensPage() {
  const { user, supabase } = useSupabase();
  const [rows, setRows] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState<MicrogreenForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("microgreens")
        .select("*")
        .eq("user_id", user.id)
        .order("name", { ascending: true });
      if (error) {
        setError(error.message);
      } else {
        setRows(data || []);
      }
      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const handleEdit = (mg: any) => {
    setError(null);
    setEditing({
      id: mg.id,
      name: mg.name,
      soaking_required: mg.soaking_required,
      germination_days: mg.germination_days,
      days_to_harvest: mg.days_to_harvest,
      sow_rate_g_per_tray: mg.sow_rate_g_per_tray,
      notes: mg.notes ?? "",
      default_soak_offset_days: mg.default_soak_offset_days ?? "",
      light_offset_days: mg.light_offset_days ?? "",
      harvest_offset_days: mg.harvest_offset_days ?? "",
    });
  };

  const handleNew = () => {
    setError(null);
    setEditing({
      name: "",
      soaking_required: false,
      germination_days: 3,
      days_to_harvest: 10,
      sow_rate_g_per_tray: 100,
      notes: "",
      default_soak_offset_days: "",
      light_offset_days: "",
      harvest_offset_days: "",
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !editing) return;
    setSaving(true);
    setError(null);

    try {
      const existing = rows ?? [];
      const duplicate = existing.find(
        (m: any) =>
          m.name.trim().toLowerCase() === editing.name.trim().toLowerCase() &&
          m.id !== editing.id
      );
      if (duplicate) {
        setError(
          "A microgreen with this name already exists for your account."
        );
        setSaving(false);
        return;
      }

      const payload: any = {
        name: editing.name.trim(),
        soaking_required: editing.soaking_required,
        germination_days: Number(editing.germination_days),
        days_to_harvest: Number(editing.days_to_harvest),
        sow_rate_g_per_tray: Number(editing.sow_rate_g_per_tray),
        notes: editing.notes || null,
        default_soak_offset_days:
          editing.default_soak_offset_days === ""
            ? null
            : Number(editing.default_soak_offset_days),
        light_offset_days:
          editing.light_offset_days === ""
            ? null
            : Number(editing.light_offset_days),
        harvest_offset_days:
          editing.harvest_offset_days === ""
            ? null
            : Number(editing.harvest_offset_days),
      };

      if (editing.id) {
        const { error } = await supabase
          .from("microgreens")
          .update(payload)
          .eq("id", editing.id)
          .eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("microgreens")
          .insert({
            ...payload,
            user_id: user.id,
          })
          .select("*");
        if (error) throw error;
        if (data) {
          setRows((prev) => [...prev, ...data]);
        }
      }
      // reload list
      const { data: refreshed } = await supabase
        .from("microgreens")
        .select("*")
        .eq("user_id", user.id)
        .order("name", { ascending: true });
      setRows(refreshed || []);
      setEditing(null);
    } catch (err: any) {
      setError(err.message || "Failed to save microgreen.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      const { error } = await supabase
        .from("microgreens")
        .delete()
        .eq("id", id)
        .eq("user_id", user?.id || "");
      if (error) throw error;
      setRows((prev) => prev.filter((m) => m.id !== id));
    } catch (err: any) {
      setError(err.message || "Failed to delete microgreen.");
    }
  };

  const list = useMemo(
    () =>
      rows.map((m: any) => (
        <tr key={m.id} className="border-b text-xs text-black">
          <td className="px-2 py-1 font-medium text-zinc-900">{m.name}</td>
          <td className="px-2 py-1">
            {m.soaking_required ? "Yes" : "No"}
          </td>
          <td className="px-2 py-1">{m.germination_days}</td>
          <td className="px-2 py-1">{m.days_to_harvest}</td>
          <td className="px-2 py-1">{m.sow_rate_g_per_tray}</td>
          <td className="px-2 py-1">
            <button
              type="button"
              className="mr-2 text-xs text-emerald-700 underline"
              onClick={() => handleEdit(m)}
            >
              Edit
            </button>
            <button
              type="button"
              className="text-xs text-red-600 underline"
              onClick={() => handleDelete(m.id)}
            >
              Delete
            </button>
          </td>
        </tr>
      )),
    [rows]
  );

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
              Microgreen Guide
            </h1>
            <p className="text-sm text-black">
              Manage microgreen parameters for scheduling and yield analysis.
            </p>
          </div>
          <button
            type="button"
            onClick={handleNew}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            New Microgreen
          </button>
        </header>

        <section className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full border-collapse text-left">
            <thead className="bg-zinc-50 text-xs text-black">
              <tr>
                <th className="px-2 py-1 font-medium">Name</th>
                <th className="px-2 py-1 font-medium">Soak?</th>
                <th className="px-2 py-1 font-medium">Germination (days)</th>
                <th className="px-2 py-1 font-medium">Days to harvest</th>
                <th className="px-2 py-1 font-medium">Sow rate (g/tray)</th>
                <th className="px-2 py-1 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-2 py-4 text-center text-xs text-black"
                  >
                    Loading microgreens…
                  </td>
                </tr>
              ) : list.length ? (
                list
              ) : (
                <tr>
                  <td
                    colSpan={6}
                    className="px-2 py-4 text-center text-xs text-black"
                  >
                    No microgreens yet. Create your first entry to start
                    planning and logging yields.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        {editing && (
          <section className="rounded-md border border-zinc-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900">
              {editing.id ? "Edit microgreen" : "New microgreen"}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-3 text-xs">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                    Soaking required
                  </label>
                  <select
                    value={editing.soaking_required ? "yes" : "no"}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        soaking_required: e.target.value === "yes",
                      })
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Germination days
                  </label>
                  <input
                    type="number"
                    required
                    value={editing.germination_days}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        germination_days: Number(e.target.value),
                      })
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Days to harvest
                  </label>
                  <input
                    type="number"
                    required
                    value={editing.days_to_harvest}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        days_to_harvest: Number(e.target.value),
                      })
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Sow rate (g per tray)
                  </label>
                  <input
                    type="number"
                    required
                    value={editing.sow_rate_g_per_tray}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        sow_rate_g_per_tray: Number(e.target.value),
                      })
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-zinc-800">
                    Default soak offset (days)
                  </label>
                  <input
                    type="number"
                    value={editing.default_soak_offset_days ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        default_soak_offset_days:
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
                    Light offset (days)
                  </label>
                  <input
                    type="number"
                    value={editing.light_offset_days ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        light_offset_days:
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
                    Harvest offset (days)
                  </label>
                  <input
                    type="number"
                    value={editing.harvest_offset_days ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        harvest_offset_days:
                          e.target.value === ""
                            ? ""
                            : Number(e.target.value),
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
                  value={editing.notes}
                  onChange={(e) =>
                    setEditing({ ...editing, notes: e.target.value })
                  }
                  rows={3}
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
                />
              </div>
              {error && (
                <p className="text-xs text-red-600" role="alert">
                  {error}
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {saving ? "Saving…" : "Save microgreen"}
                </button>
                <button
                type="button"
                className="text-xs text-black underline"
                onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}
      </div>
    </AuthGuard>
  );
}

