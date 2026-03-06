"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";

type MachineSettings = {
  id: string;
  number_of_freeze_dryers: number;
  trays_per_machine_per_cycle: number;
  operating_hours_per_day: number;
  operating_days_per_week: number;
  default_defrost_cleaning_hours: number;
  default_fresh_load_per_tray_g: number;
};

type ProfileRow = {
  id: string;
  name: string;
  profile_type: string;
  linked_microgreen_id: string | null;
  cycle_time_hours: number;
  defrost_cleaning_hours_override: number | null;
  dry_matter_fraction: number | null;
  fresh_load_per_tray_g_override: number | null;
  notes: string | null;
};

export default function CalibrationPage() {
  const { user, supabase } = useSupabase();

  // Machine-level settings
  const [machine, setMachine] = useState<MachineSettings | null>(null);
  const [machineForm, setMachineForm] = useState<Partial<MachineSettings>>({
    number_of_freeze_dryers: 1,
    trays_per_machine_per_cycle: 10,
    operating_hours_per_day: 16,
    operating_days_per_week: 6,
    default_defrost_cleaning_hours: 2,
    default_fresh_load_per_tray_g: 1500,
  });
  const [machineSaving, setMachineSaving] = useState(false);
  const [machineError, setMachineError] = useState<string | null>(null);
  const [machineMessage, setMachineMessage] = useState<string | null>(null);

  // Profiles
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [microgreens, setMicrogreens] = useState<any[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    null,
  );
  const [profileEditing, setProfileEditing] = useState<Partial<ProfileRow> | null>(
    null,
  );
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      const [mRes, pRes, mgRes] = await Promise.all([
        supabase
          .from("freeze_dryer_machine_settings")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("freeze_dryer_profiles")
          .select("*")
          .eq("user_id", user.id)
          .order("name", { ascending: true }),
        supabase
          .from("microgreens")
          .select("*")
          .eq("user_id", user.id)
          .order("name", { ascending: true }),
      ]);

      if (mRes.error) {
        setMachineError(mRes.error.message);
      } else if (mRes.data) {
        setMachine(mRes.data as MachineSettings);
        setMachineForm(mRes.data as MachineSettings);
      }

      if (!pRes.error && pRes.data) {
        setProfiles(pRes.data as ProfileRow[]);
      }

      if (!mgRes.error && mgRes.data) {
        setMicrogreens(mgRes.data || []);
      }

      setIsLoading(false);
    };
    load();
  }, [user, supabase]);

  const handleMachineChange = (field: keyof MachineSettings, value: string) => {
    const parsed = value === "" ? "" : Number(value);
    setMachineForm((prev: any) => ({ ...prev, [field]: parsed }));
  };

  const handleMachineSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setMachineSaving(true);
    setMachineError(null);
    setMachineMessage(null);
    try {
      if (machine) {
        const { error } = await supabase
          .from("freeze_dryer_machine_settings")
          .update({
            ...machineForm,
            updated_at: new Date().toISOString(),
          })
          .eq("id", machine.id)
          .eq("user_id", user.id);
        if (error) throw error;
        setMachine({ ...(machine as MachineSettings), ...(machineForm as any) });
      } else {
        const { data, error } = await supabase
          .from("freeze_dryer_machine_settings")
          .insert({
            ...machineForm,
            user_id: user.id,
          })
          .select("*")
          .maybeSingle();
        if (error) throw error;
        if (data) {
          setMachine(data as MachineSettings);
          setMachineForm(data as MachineSettings);
        }
      }
      setMachineMessage("Machine settings saved.");
    } catch (err: any) {
      setMachineError(err.message || "Failed to save machine settings.");
    } finally {
      setMachineSaving(false);
    }
  };

  const effectiveProfileMetrics = useMemo(() => {
    if (!machine || !selectedProfileId) return null;
    const profile = profiles.find((p) => p.id === selectedProfileId);
    if (!profile) return null;
    const effectiveDefrost =
      profile.defrost_cleaning_hours_override ??
      machine.default_defrost_cleaning_hours;
    const effectiveLoad =
      profile.fresh_load_per_tray_g_override ??
      machine.default_fresh_load_per_tray_g;
    const hoursPerCycle = profile.cycle_time_hours + effectiveDefrost;
    const perCycleFreshCapacity =
      machine.number_of_freeze_dryers *
      machine.trays_per_machine_per_cycle *
      effectiveLoad;
    return {
      profile,
      effectiveDefrost,
      effectiveLoad,
      hoursPerCycle,
      perCycleFreshCapacity,
    };
  }, [machine, profiles, selectedProfileId]);

  const handleNewProfile = () => {
    setProfileError(null);
    setProfileEditing({
      name: "",
      profile_type: "dried_microgreen",
      linked_microgreen_id: null,
      cycle_time_hours: 24,
      defrost_cleaning_hours_override: null,
      dry_matter_fraction: 0.1,
      fresh_load_per_tray_g_override: null,
      notes: "",
    });
  };

  const handleEditProfile = (p: ProfileRow) => {
    setProfileError(null);
    setProfileEditing({ ...p });
  };

  const handleProfileSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !profileEditing) return;
    setProfileSaving(true);
    setProfileError(null);
    try {
      const duplicate = profiles.find(
        (p) =>
          p.name.trim().toLowerCase() ===
            (profileEditing.name || "").trim().toLowerCase() &&
          p.id !== profileEditing.id,
      );
      if (duplicate) {
        setProfileError(
          "A freeze dryer profile with this name already exists for your account.",
        );
        setProfileSaving(false);
        return;
      }

      const payload: any = {
        name: (profileEditing.name || "").trim(),
        profile_type: profileEditing.profile_type || "dried_microgreen",
        linked_microgreen_id: profileEditing.linked_microgreen_id || null,
        cycle_time_hours: Number(profileEditing.cycle_time_hours || 0),
        defrost_cleaning_hours_override:
          profileEditing.defrost_cleaning_hours_override === null ||
          profileEditing.defrost_cleaning_hours_override === undefined ||
          profileEditing.defrost_cleaning_hours_override === ("" as any)
            ? null
            : Number(profileEditing.defrost_cleaning_hours_override),
        dry_matter_fraction:
          profileEditing.dry_matter_fraction === null ||
          profileEditing.dry_matter_fraction === undefined ||
          profileEditing.dry_matter_fraction === ("" as any)
            ? null
            : Number(profileEditing.dry_matter_fraction),
        fresh_load_per_tray_g_override:
          profileEditing.fresh_load_per_tray_g_override === null ||
          profileEditing.fresh_load_per_tray_g_override === undefined ||
          profileEditing.fresh_load_per_tray_g_override === ("" as any)
            ? null
            : Number(profileEditing.fresh_load_per_tray_g_override),
        notes: profileEditing.notes || null,
        updated_at: new Date().toISOString(),
      };

      if (profileEditing.id) {
        const { error } = await supabase
          .from("freeze_dryer_profiles")
          .update(payload)
          .eq("id", profileEditing.id)
          .eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("freeze_dryer_profiles")
          .insert({
            ...payload,
            user_id: user.id,
          })
          .select("*");
        if (error) throw error;
        if (data && data[0]) {
          setSelectedProfileId(data[0].id);
        }
      }

      const { data: refreshed } = await supabase
        .from("freeze_dryer_profiles")
        .select("*")
        .eq("user_id", user.id)
        .order("name", { ascending: true });
      setProfiles((refreshed || []) as ProfileRow[]);
      setProfileEditing(null);
    } catch (err: any) {
      setProfileError(err.message || "Failed to save freeze dryer profile.");
    } finally {
      setProfileSaving(false);
    }
  };

  const handleDeleteProfile = async (id: string) => {
    if (!user) return;
    setProfileError(null);
    try {
      const { error } = await supabase
        .from("freeze_dryer_profiles")
        .delete()
        .eq("id", id)
        .eq("user_id", user.id);
      if (error) throw error;
      setProfiles((prev) => prev.filter((p) => p.id !== id));
      if (selectedProfileId === id) {
        setSelectedProfileId(null);
      }
    } catch (err: any) {
      setProfileError(err.message || "Failed to delete profile.");
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Freeze Dryer Calibration
          </h1>
          <p className="text-sm text-zinc-600">
            Maintain machine-level settings and ingredient-specific profiles to
            drive feasibility and tray/schedule planning.
          </p>
        </header>

        {/* Machine settings */}
        <section className="space-y-3 rounded-md border border-zinc-200 bg-white p-4 text-xs">
          <h2 className="text-sm font-semibold text-zinc-900">
            Machine / Facility Settings
          </h2>
          {!machine && !isLoading && (
            <p className="text-[11px] text-zinc-600">
              No machine settings found. Create a baseline configuration for
              your freeze dryers.
            </p>
          )}
          <form onSubmit={handleMachineSubmit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <MachineNumberInput
                label="Number of freeze dryers"
                value={machineForm.number_of_freeze_dryers ?? ""}
                onChange={(v) =>
                  handleMachineChange("number_of_freeze_dryers", v)
                }
              />
              <MachineNumberInput
                label="Trays per machine per cycle"
                value={machineForm.trays_per_machine_per_cycle ?? ""}
                onChange={(v) =>
                  handleMachineChange("trays_per_machine_per_cycle", v)
                }
              />
              <MachineNumberInput
                label="Operating hours per day"
                value={machineForm.operating_hours_per_day ?? ""}
                onChange={(v) =>
                  handleMachineChange("operating_hours_per_day", v)
                }
              />
              <MachineNumberInput
                label="Operating days per week"
                value={machineForm.operating_days_per_week ?? ""}
                onChange={(v) =>
                  handleMachineChange("operating_days_per_week", v)
                }
              />
              <MachineNumberInput
                label="Default defrost & cleaning (hours)"
                value={machineForm.default_defrost_cleaning_hours ?? ""}
                onChange={(v) =>
                  handleMachineChange("default_defrost_cleaning_hours", v)
                }
              />
              <MachineNumberInput
                label="Default fresh load per tray (g)"
                value={machineForm.default_fresh_load_per_tray_g ?? ""}
                onChange={(v) =>
                  handleMachineChange("default_fresh_load_per_tray_g", v)
                }
              />
            </div>
            {machineError && (
              <p className="text-[11px] text-red-600" role="alert">
                {machineError}
              </p>
            )}
            {machineMessage && (
              <p className="text-[11px] text-emerald-700" role="status">
                {machineMessage}
              </p>
            )}
            <button
              type="submit"
              disabled={machineSaving}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {machineSaving ? "Saving…" : "Save machine settings"}
            </button>
          </form>
        </section>

        {/* Profiles */}
        <section className="space-y-4 rounded-md border border-zinc-200 bg-white p-4 text-xs">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">
                Ingredient / Material Freeze Dryer Profiles
              </h2>
              <p className="text-[11px] text-zinc-600">
                Profiles override machine defaults for specific ingredients and
                are used to compute cycle times, fresh loads, and dry fractions.
              </p>
            </div>
            <button
              type="button"
              onClick={handleNewProfile}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700"
            >
              New profile
            </button>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <div className="max-h-64 overflow-y-auto rounded-md border border-zinc-200">
                <table className="min-w-full border-collapse text-left">
                  <thead className="bg-zinc-50 text-[11px] text-zinc-600">
                    <tr>
                      <th className="px-2 py-1 font-medium">Name</th>
                      <th className="px-2 py-1 font-medium">Type</th>
                      <th className="px-2 py-1 font-medium">Linked microgreen</th>
                      <th className="px-2 py-1 font-medium">Cycle hours</th>
                      <th className="px-2 py-1 font-medium">Dry fraction</th>
                      <th className="px-2 py-1 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-2 py-3 text-center text-[11px] text-zinc-500"
                        >
                          Loading profiles…
                        </td>
                      </tr>
                    ) : profiles.length ? (
                      profiles.map((p) => {
                        const mg = microgreens.find(
                          (m: any) => m.id === p.linked_microgreen_id,
                        );
                        return (
                          <tr
                            key={p.id}
                            className={`border-b text-[11px] ${
                              selectedProfileId === p.id
                                ? "bg-emerald-50"
                                : "bg-white"
                            }`}
                          >
                            <td className="px-2 py-1">{p.name}</td>
                            <td className="px-2 py-1">{p.profile_type}</td>
                            <td className="px-2 py-1">{mg?.name ?? "-"}</td>
                            <td className="px-2 py-1">
                              {p.cycle_time_hours.toFixed(1)}
                            </td>
                            <td className="px-2 py-1">
                              {p.dry_matter_fraction != null
                                ? p.dry_matter_fraction.toFixed(3)
                                : "-"}
                            </td>
                            <td className="px-2 py-1">
                              <button
                                type="button"
                                className="mr-2 text-[11px] text-emerald-700 underline"
                                onClick={() => {
                                  setSelectedProfileId(p.id);
                                  handleEditProfile(p);
                                }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="text-[11px] text-red-600 underline"
                                onClick={() => handleDeleteProfile(p.id)}
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-2 py-3 text-center text-[11px] text-zinc-500"
                        >
                          No profiles yet. Create profiles for key ingredients,
                          raw and dried microgreens.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                <h3 className="mb-2 text-[11px] font-semibold text-zinc-900">
                  Derived metrics (selected profile)
                </h3>
                {!effectiveProfileMetrics ? (
                  <p className="text-[11px] text-zinc-500">
                    Select a profile to see how it overrides machine defaults.
                  </p>
                ) : (
                  <>
                    <p className="text-[11px] text-zinc-700">
                      <span className="font-semibold">
                        Hours per cycle:{" "}
                      </span>
                      {effectiveProfileMetrics.hoursPerCycle.toFixed(2)}
                    </p>
                    <p className="text-[11px] text-zinc-700">
                      <span className="font-semibold">
                        Effective defrost/cleaning (h):{" "}
                      </span>
                      {effectiveProfileMetrics.effectiveDefrost.toFixed(2)}{" "}
                      {effectiveProfileMetrics.profile
                        .defrost_cleaning_hours_override != null &&
                        "(profile override)"}
                    </p>
                    <p className="text-[11px] text-zinc-700">
                      <span className="font-semibold">
                        Effective fresh load / tray (g):{" "}
                      </span>
                      {effectiveProfileMetrics.effectiveLoad.toFixed(1)}{" "}
                      {effectiveProfileMetrics.profile
                        .fresh_load_per_tray_g_override != null &&
                        "(profile override)"}
                    </p>
                    <p className="text-[11px] text-zinc-700">
                      <span className="font-semibold">
                        Per-cycle fresh capacity (g):{" "}
                      </span>
                      {effectiveProfileMetrics.perCycleFreshCapacity.toFixed(1)}
                    </p>
                  </>
                )}
              </div>
              {profileEditing && (
                <form
                  onSubmit={handleProfileSubmit}
                  className="space-y-2 rounded-md border border-zinc-200 bg-white p-3"
                >
                  <h3 className="text-[11px] font-semibold text-zinc-900">
                    {profileEditing.id
                      ? "Edit freeze dryer profile"
                      : "New freeze dryer profile"}
                  </h3>
                  <div className="space-y-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-zinc-800">
                        Name
                      </label>
                      <input
                        type="text"
                        required
                        value={profileEditing.name ?? ""}
                        onChange={(e) =>
                          setProfileEditing((prev) => ({
                            ...(prev as any),
                            name: e.target.value,
                          }))
                        }
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-zinc-800">
                        Profile type
                      </label>
                      <select
                        value={profileEditing.profile_type ?? "dried_microgreen"}
                        onChange={(e) =>
                          setProfileEditing((prev) => ({
                            ...(prev as any),
                            profile_type: e.target.value,
                          }))
                        }
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      >
                        <option value="raw_microgreen">Raw microgreen</option>
                        <option value="dried_microgreen">Dried microgreen</option>
                        <option value="ingredient">Ingredient</option>
                        <option value="blend_component">Blend component</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-zinc-800">
                        Linked microgreen (optional)
                      </label>
                      <select
                        value={profileEditing.linked_microgreen_id ?? ""}
                        onChange={(e) =>
                          setProfileEditing((prev) => ({
                            ...(prev as any),
                            linked_microgreen_id: e.target.value || null,
                          }))
                        }
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      >
                        <option value="">None</option>
                        {microgreens.map((m: any) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-zinc-800">
                        Cycle time (hours)
                      </label>
                      <input
                        type="number"
                        step="any"
                        required
                        value={profileEditing.cycle_time_hours ?? ""}
                        onChange={(e) =>
                          setProfileEditing((prev) => ({
                            ...(prev as any),
                            cycle_time_hours:
                              e.target.value === ""
                                ? ""
                                : Number(e.target.value),
                          }))
                        }
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-zinc-800">
                        Defrost & cleaning override (hours, optional)
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={
                          (profileEditing
                            .defrost_cleaning_hours_override as any) ?? ""
                        }
                        onChange={(e) =>
                          setProfileEditing((prev) => ({
                            ...(prev as any),
                            defrost_cleaning_hours_override:
                              e.target.value === ""
                                ? ("" as any)
                                : Number(e.target.value),
                          }))
                        }
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-zinc-800">
                        Dry matter fraction (0–1, optional)
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={(profileEditing.dry_matter_fraction as any) ?? ""}
                        onChange={(e) =>
                          setProfileEditing((prev) => ({
                            ...(prev as any),
                            dry_matter_fraction:
                              e.target.value === ""
                                ? ("" as any)
                                : Number(e.target.value),
                          }))
                        }
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-zinc-800">
                        Fresh load per tray override (g, optional)
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={
                          (profileEditing
                            .fresh_load_per_tray_g_override as any) ?? ""
                        }
                        onChange={(e) =>
                          setProfileEditing((prev) => ({
                            ...(prev as any),
                            fresh_load_per_tray_g_override:
                              e.target.value === ""
                                ? ("" as any)
                                : Number(e.target.value),
                          }))
                        }
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-zinc-800">
                        Notes
                      </label>
                      <textarea
                        rows={3}
                        value={profileEditing.notes ?? ""}
                        onChange={(e) =>
                          setProfileEditing((prev) => ({
                            ...(prev as any),
                            notes: e.target.value,
                          }))
                        }
                        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                    </div>
                  </div>
                  {profileError && (
                    <p className="text-[11px] text-red-600" role="alert">
                      {profileError}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={profileSaving}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {profileSaving ? "Saving…" : "Save profile"}
                    </button>
                    <button
                      type="button"
                      className="text-[11px] text-zinc-500 underline"
                      onClick={() => setProfileEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </section>
      </div>
    </AuthGuard>
  );
}

function MachineNumberInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | "" | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-zinc-800">
        {label}
      </label>
      <input
        type="number"
        step="any"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500 bg-white"
      />
    </div>
  );
}


