"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";
import type { Employee } from "@/lib/employees";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

type EmployeeForm = { id?: string; full_name: string; role_title: string; active: boolean };

export default function EmployeesPage() {
  const { user, supabase } = useSupabase();

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [usedEmployeeIds, setUsedEmployeeIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editing, setEditing] = useState<EmployeeForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<Employee | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [employeesResult, performedResult, reviewedResult] = await Promise.all([
        supabase.from("employees").select("id, full_name, role_title, active, created_at").order("full_name"),
        supabase.from("log_entries").select("performed_by_employee_id"),
        supabase.from("log_entry_reviews").select("reviewed_by_employee_id"),
      ]);
      if (employeesResult.error) throw new Error(employeesResult.error.message);
      setEmployees((employeesResult.data ?? []) as Employee[]);

      const used = new Set<string>();
      for (const row of (performedResult.data ?? []) as Array<{ performed_by_employee_id: string | null }>) {
        if (row.performed_by_employee_id) used.add(row.performed_by_employee_id);
      }
      for (const row of (reviewedResult.data ?? []) as Array<{ reviewed_by_employee_id: string | null }>) {
        if (row.reviewed_by_employee_id) used.add(row.reviewed_by_employee_id);
      }
      setUsedEmployeeIds(used);
    } catch (err: any) {
      setLoadError(err.message || "Failed to load employees.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const sortedEmployees = useMemo(
    () => [...employees].sort((a, b) => Number(b.active) - Number(a.active) || a.full_name.localeCompare(b.full_name)),
    [employees],
  );

  const handleNew = () => {
    setFormError(null);
    setEditing({ full_name: "", role_title: "", active: true });
  };

  const handleEdit = (employee: Employee) => {
    setFormError(null);
    setEditing({ id: employee.id, full_name: employee.full_name, role_title: employee.role_title ?? "", active: employee.active });
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.full_name.trim()) {
      setFormError("Full name is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        full_name: editing.full_name.trim(),
        role_title: editing.role_title.trim() || null,
        active: editing.active,
      };
      if (editing.id) {
        const { error } = await supabase.from("employees").update(payload).eq("id", editing.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from("employees").insert(payload);
        if (error) throw new Error(error.message);
      }
      setEditing(null);
      await load();
    } catch (err: any) {
      setFormError(err.message || "Failed to save this employee.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (employee: Employee) => {
    try {
      const { error } = await supabase.from("employees").update({ active: !employee.active }).eq("id", employee.id);
      if (error) throw new Error(error.message);
      await load();
    } catch (err: any) {
      setLoadError(err.message || "Failed to update this employee.");
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from("employees").delete().eq("id", deleteConfirm.id);
      if (error) throw new Error(error.message);
      setDeleteConfirm(null);
      await load();
    } catch (err: any) {
      setLoadError(err.message || "Failed to delete this employee.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Link
              href="/compliance/logs"
              className="mb-1 inline-block text-[11px] font-medium text-emerald-700 underline"
            >
              ← Back to Logs
            </Link>
            <h1 className="text-2xl font-semibold text-zinc-900">Employees</h1>
            <p className="text-sm text-black">
              A name roster for log forms — not a login. &ldquo;Performed by&rdquo; and
              &ldquo;Reviewed by&rdquo; are selections from this list, not authenticated identity.
            </p>
          </div>
          <button
            type="button"
            onClick={handleNew}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            New Employee
          </button>
        </div>

        {loadError && (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        )}

        <section className="rounded-md border border-zinc-200 bg-white p-4">
          {loading ? (
            <p className="text-xs text-black">Loading…</p>
          ) : sortedEmployees.length === 0 ? (
            <p className="text-xs text-black">No employees yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Since</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedEmployees.map((employee) => {
                    const isUsed = usedEmployeeIds.has(employee.id);
                    return (
                      <tr key={employee.id} className="border-b border-zinc-100">
                        <td className="px-3 py-2 text-zinc-900">{employee.full_name}</td>
                        <td className="px-3 py-2 text-zinc-700">{employee.role_title || "—"}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              employee.active ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"
                            }`}
                          >
                            {employee.active ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-zinc-700">{formatDate(employee.created_at)}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleEdit(employee)}
                              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleActive(employee)}
                              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                            >
                              {employee.active ? "Deactivate" : "Reactivate"}
                            </button>
                            {!isUsed && (
                              <button
                                type="button"
                                onClick={() => setDeleteConfirm(employee)}
                                className="rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 shadow-sm hover:bg-red-50"
                              >
                                Delete
                              </button>
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

        {editing && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">
                {editing.id ? "Edit Employee" : "New Employee"}
              </h2>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Full name</label>
                  <input
                    value={editing.full_name}
                    onChange={(e) => setEditing({ ...editing, full_name: e.target.value })}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Role title (optional)</label>
                  <input
                    value={editing.role_title}
                    onChange={(e) => setEditing({ ...editing, role_title: e.target.value })}
                    className={inputClassName}
                  />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-black">
                  <input
                    type="checkbox"
                    checked={editing.active}
                    onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                    className="h-3.5 w-3.5"
                  />
                  Active (appears in &ldquo;Performed by&rdquo; dropdowns)
                </label>
                {formError && (
                  <p className="text-xs text-red-600" role="alert">
                    {formError}
                  </p>
                )}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  disabled={saving}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">Delete this employee?</h2>
              <p className="mt-1 text-xs text-zinc-600">
                &ldquo;{deleteConfirm.full_name}&rdquo; has never been used on a log entry, so this
                removes them permanently. If they might be used later, Deactivate instead.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(null)}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
