"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { apiFetch } from "@/lib/access/clientFetch";
import { ADMIN_ONLY_NOTE, FEATURES, FEATURE_GROUPS, previewSidebarLabels } from "@/lib/access/catalog";
import { formatNyDate, formatNyDateTime } from "@/lib/nyTime";

type Role = { id: string; name: string; description: string | null; isAdmin: boolean; isSystem: boolean; features: string[]; employeeCount: number };
type Employee = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  status: "invited" | "active" | "deactivated" | "deleted";
  invitedAt: string | null;
  acceptedAt: string | null;
  deletePending: boolean;
  roles: Array<{ id: string; name: string; isAdmin: boolean }>;
};
type Login = { userId: string; email: string | null; createdAt: string | null; lastSignInAt: string | null };
type Activity = { id: string; actor_name: string; action: string; target: string | null; created_at: string };

const STATUS_LABEL: Record<Employee["status"], string> = { invited: "Invited", active: "Active", deactivated: "Deactivated", deleted: "Deleted" };
const ACTION_LABEL: Record<string, string> = {
  invited: "invited", invite_resent: "resent the invite to", invite_revoked: "revoked the invite of", roles_changed: "changed the roles of",
  role_created: "created the role", role_edited: "edited the role", role_deleted: "deleted the role", deactivated: "deactivated",
  reactivated: "reactivated", deleted: "deleted", profile_completed: "completed the profile of", admin_bootstrapped: "made an Admin:",
};
const nameOf = (e: { firstName: string | null; lastName: string | null }) => [e.firstName, e.lastName].filter(Boolean).join(" ") || "(no name yet)";

const btn = "rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-black hover:bg-zinc-50 disabled:opacity-50";
const primary = "rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const danger = "rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50";

function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`max-h-[90vh] w-full overflow-y-auto rounded-md border border-zinc-200 bg-white p-4 text-black shadow-lg ${wide ? "max-w-3xl" : "max-w-md"}`}>
        <h2 className="text-sm font-semibold text-black">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <p className="text-sm text-red-700" role="alert">
      {children}
    </p>
  ) : null;
}

export default function EmployeesPage() {
  const [tab, setTab] = useState<"employees" | "roles">("employees");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [logins, setLogins] = useState<Login[] | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<
    | null
    | { kind: "invite" }
    | { kind: "roles"; emp: Employee }
    | { kind: "delete"; emp: Employee }
    | { kind: "deleteLogin"; login: Login }
    | { kind: "role"; role: Role | null }
    | { kind: "deleteRole"; role: Role }
  >(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [e, r, a] = await Promise.all([
        apiFetch<{ employees: Employee[] }>("/api/admin/employees"),
        apiFetch<{ roles: Role[] }>("/api/admin/roles"),
        apiFetch<{ activity: Activity[] }>("/api/admin/activity"),
      ]);
      setEmployees(e.employees);
      setRoles(r.roles);
      setActivity(a.activity);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load employees.");
    } finally {
      setLoading(false);
    }
    apiFetch<{ logins: Login[] }>("/api/admin/unrecognized")
      .then((u) => setLogins(u.logins))
      .catch(() => setLogins([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await load();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Something went wrong.";
    }
  };

  const [rowError, setRowError] = useState<Record<string, string>>({});
  const rowAct = async (id: string, fn: () => Promise<unknown>, done: string) => {
    const e = await act(fn, done);
    setRowError((m) => ({ ...m, [id]: e ?? "" }));
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl text-black">
        <h1 className="mb-1 text-2xl font-semibold text-black">Employees</h1>
        <p className="mb-4 text-sm text-black">Who can sign in, and what each role can use. Only Admins see this page.</p>

        <div className="mb-4 flex gap-1 border-b border-zinc-200" role="tablist">
          {(["employees", "roles"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium text-black ${tab === t ? "border-emerald-600" : "border-transparent hover:border-zinc-300"}`}
            >
              {t === "employees" ? "Employees" : "Roles"}
            </button>
          ))}
        </div>

        {notice && (
          <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-black ring-1 ring-emerald-300" role="status">
            {notice}
          </p>
        )}
        <ErrorText>{loadError}</ErrorText>
        {loading && <p className="text-sm text-black">Loading…</p>}

        {!loading && tab === "employees" && (
          <div className="space-y-6">
            <div className="flex justify-end">
              <button className={primary} onClick={() => setModal({ kind: "invite" })}>
                Invite employee
              </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="min-w-full text-left text-sm text-black" data-testid="employees-table">
                <thead className="bg-zinc-50 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Roles</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Invited / accepted</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-4 text-center">
                        No employees yet.
                      </td>
                    </tr>
                  )}
                  {employees.map((e) => (
                    <tr key={e.id} className="border-t border-zinc-100 align-top" data-testid={`employee-row-${e.email ?? e.id}`}>
                      <td className="px-3 py-2 font-medium">{nameOf(e)}</td>
                      <td className="px-3 py-2">{e.email ?? "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {e.roles.map((r) => (
                            <span key={r.id} className={`rounded-full px-2 py-0.5 text-[11px] font-medium text-black ${r.isAdmin ? "bg-amber-200" : "bg-zinc-100"}`}>
                              {r.name}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">{e.deletePending ? "Deleted (login removal pending)" : STATUS_LABEL[e.status]}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {e.acceptedAt ? `Accepted ${formatNyDate(e.acceptedAt)}` : e.invitedAt ? `Invited ${formatNyDate(e.invitedAt)}` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {e.deletePending ? (
                            <button className={btn} onClick={() => rowAct(e.id, () => apiFetch(`/api/admin/employees/${e.id}/delete`, { body: {} }), "Login deleted.")}>
                              Retry
                            </button>
                          ) : (
                            <>
                              <button className={btn} onClick={() => setModal({ kind: "roles", emp: e })}>
                                Edit roles
                              </button>
                              {e.status === "invited" && (
                                <>
                                  <button className={btn} onClick={() => rowAct(e.id, () => apiFetch(`/api/admin/employees/${e.id}/resend`, { body: {} }), `A new invite was sent to ${e.email}.`)}>
                                    Resend invite
                                  </button>
                                  <button className={btn} onClick={() => rowAct(e.id, () => apiFetch(`/api/admin/employees/${e.id}/revoke`, { body: {} }), "Invite revoked.")}>
                                    Revoke invite
                                  </button>
                                </>
                              )}
                              {(e.status === "active" || e.status === "invited") && (
                                <button className={btn} onClick={() => rowAct(e.id, () => apiFetch(`/api/admin/employees/${e.id}/status`, { body: { active: false } }), `${nameOf(e)} was deactivated.`)}>
                                  Deactivate
                                </button>
                              )}
                              {e.status === "deactivated" && (
                                <button className={btn} onClick={() => rowAct(e.id, () => apiFetch(`/api/admin/employees/${e.id}/status`, { body: { active: true } }), `${nameOf(e)} was reactivated.`)}>
                                  Reactivate
                                </button>
                              )}
                              <button className={`${btn} text-red-700`} onClick={() => setModal({ kind: "delete", emp: e })}>
                                Delete account
                              </button>
                            </>
                          )}
                        </div>
                        {rowError[e.id] && <p className="mt-1 text-xs text-red-700" role="alert">{rowError[e.id]}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <section className="rounded-lg border border-zinc-200 bg-white p-4" aria-label="Unrecognized accounts" data-testid="unrecognized">
              <h2 className="text-sm font-semibold text-black">Unrecognized accounts</h2>
              <p className="mt-1 text-xs text-black">Sign-in accounts that don&apos;t belong to any employee. They can&apos;t use the ERP; delete them to clean up.</p>
              {logins === null ? (
                <p className="mt-2 text-xs text-black">Loading…</p>
              ) : logins.length === 0 ? (
                <p className="mt-2 text-xs text-black">None.</p>
              ) : (
                <ul className="mt-2 divide-y divide-zinc-100 text-sm">
                  {logins.map((l) => (
                    <li key={l.userId} className="flex items-center justify-between gap-2 py-1.5">
                      <span>
                        {l.email ?? "(no email)"}
                        <span className="ml-2 text-xs">created {l.createdAt ? formatNyDate(l.createdAt) : "—"}</span>
                      </span>
                      <button className={`${btn} text-red-700`} onClick={() => setModal({ kind: "deleteLogin", login: l })}>
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <details className="rounded-lg border border-zinc-200 bg-white p-4" data-testid="activity">
              <summary className="cursor-pointer text-sm font-semibold text-black">Activity</summary>
              <ul className="mt-2 space-y-1 text-sm">
                {activity.length === 0 && <li>No activity yet.</li>}
                {activity.map((a) => (
                  <li key={a.id}>
                    <span className="whitespace-nowrap">{formatNyDateTime(a.created_at)}</span> · {a.actor_name} {ACTION_LABEL[a.action] ?? a.action} {a.target ?? ""}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {!loading && tab === "roles" && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <button className={primary} onClick={() => setModal({ kind: "role", role: null })}>
                New role
              </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="min-w-full text-left text-sm text-black" data-testid="roles-table">
                <thead className="bg-zinc-50 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 font-medium">Employees</th>
                    <th className="px-3 py-2 font-medium">Features</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => (
                    <tr key={r.id} className="border-t border-zinc-100" data-testid={`role-row-${r.name}`}>
                      <td className="px-3 py-2 font-medium">
                        {r.name}
                        {r.isSystem && <span className="ml-2 rounded-full bg-amber-200 px-2 py-0.5 text-[11px]">Locked</span>}
                      </td>
                      <td className="px-3 py-2">{r.isAdmin ? "Full access to everything, including features added in the future." : r.description ?? ""}</td>
                      <td className="px-3 py-2">{r.employeeCount}</td>
                      <td className="px-3 py-2">{r.isAdmin ? "All" : r.features.length}</td>
                      <td className="px-3 py-2">
                        {!r.isSystem && (
                          <div className="flex gap-1">
                            <button className={btn} onClick={() => setModal({ kind: "role", role: r })}>
                              Edit
                            </button>
                            <button
                              className={`${btn} text-red-700`}
                              disabled={r.employeeCount > 0}
                              title={r.employeeCount > 0 ? `${r.employeeCount} employee(s) have this role. Remove it from them first.` : undefined}
                              onClick={() => setModal({ kind: "deleteRole", role: r })}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-black">{ADMIN_ONLY_NOTE}</p>
          </div>
        )}

        {modal?.kind === "invite" && (
          <InviteDialog
            roles={roles}
            onClose={() => setModal(null)}
            onSubmit={async (input) => {
              const r = await apiFetch<{ mode: string }>("/api/admin/employees", { body: input }).catch((e) => e as Error);
              if (r instanceof Error) return r.message;
              setModal(null);
              setNotice(
                r.mode === "linked_existing"
                  ? `${input.email} already had a sign-in account, so it was linked and sent a password-reset link instead of an invite.`
                  : `Invite sent to ${input.email}.`,
              );
              await load();
              return null;
            }}
          />
        )}
        {modal?.kind === "roles" && (
          <EmployeeRolesDialog
            emp={modal.emp}
            roles={roles}
            onClose={() => setModal(null)}
            onSubmit={async (roleIds, confirmAdmin) => {
              const err = await act(() => apiFetch(`/api/admin/employees/${modal.emp.id}/roles`, { method: "PUT", body: { roleIds, confirmAdmin } }), `Roles updated for ${nameOf(modal.emp)}.`);
              if (!err) setModal(null);
              return err;
            }}
          />
        )}
        {modal?.kind === "delete" && (
          <DeleteAccountDialog
            emp={modal.emp}
            onClose={() => setModal(null)}
            onSubmit={async (confirmEmail) => {
              const err = await act(() => apiFetch(`/api/admin/employees/${modal.emp.id}/delete`, { body: { confirmEmail } }), `${nameOf(modal.emp)}'s account was deleted.`);
              if (!err) setModal(null);
              else await load();
              return err;
            }}
          />
        )}
        {modal?.kind === "deleteLogin" && (
          <Dialog title="Delete this login?" onClose={() => setModal(null)}>
            <ConfirmBody
              text={`This permanently deletes the sign-in account ${modal.login.email ?? ""}. It doesn't belong to any employee.`}
              confirmLabel="Delete login"
              onCancel={() => setModal(null)}
              onConfirm={async () => {
                const err = await act(() => apiFetch(`/api/admin/unrecognized/${modal.login.userId}`, { method: "DELETE" }), "Login deleted.");
                if (!err) setModal(null);
                return err;
              }}
            />
          </Dialog>
        )}
        {modal?.kind === "role" && (
          <RoleEditor
            role={modal.role}
            onClose={() => setModal(null)}
            onSubmit={async (input) => {
              const err = await act(
                () => (modal.role ? apiFetch(`/api/admin/roles/${modal.role.id}`, { method: "PUT", body: input }) : apiFetch("/api/admin/roles", { body: input })),
                modal.role ? `Role "${input.name}" saved. Changes apply on each person's next page load.` : `Role "${input.name}" created.`,
              );
              if (!err) setModal(null);
              return err;
            }}
          />
        )}
        {modal?.kind === "deleteRole" && (
          <Dialog title={`Delete the role "${modal.role.name}"?`} onClose={() => setModal(null)}>
            <ConfirmBody
              text="This permanently deletes the role. No one has it right now."
              confirmLabel="Delete role"
              onCancel={() => setModal(null)}
              onConfirm={async () => {
                const err = await act(() => apiFetch(`/api/admin/roles/${modal.role.id}`, { method: "DELETE" }), `Role "${modal.role.name}" deleted.`);
                if (!err) setModal(null);
                return err;
              }}
            />
          </Dialog>
        )}
      </div>
    </AuthGuard>
  );
}

function ConfirmBody({ text, confirmLabel, onCancel, onConfirm }: { text: string; confirmLabel: string; onCancel: () => void; onConfirm: () => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3 text-sm text-black">
      <p>{text}</p>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <button className={btn} onClick={onCancel}>
          Cancel
        </button>
        <button
          className={danger}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(await onConfirm());
            setBusy(false);
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

function RolePicker({ roles, selected, onChange }: { roles: Role[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium text-black">Roles (at least one)</legend>
      <div className="space-y-1">
        {roles.map((r) => (
          <label key={r.id} className="flex items-start gap-2 text-sm text-black">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={selected.includes(r.id)}
              onChange={(e) => onChange(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))}
            />
            <span>
              {r.name}
              {r.isAdmin && <span className="ml-1 text-xs">(full access)</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AdminConfirm({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-sm text-black ring-1 ring-amber-300">
      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Yes, give this person full Admin access, including Employees and Roles.
    </label>
  );
}

function InviteDialog({ roles, onClose, onSubmit }: { roles: Role[]; onClose: () => void; onSubmit: (i: { firstName: string; lastName: string; email: string; roleIds: string[]; confirmAdmin: boolean }) => Promise<string | null> }) {
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const adminPicked = roles.some((r) => r.isAdmin && roleIds.includes(r.id));
  const valid = firstName.trim() && lastName.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && roleIds.length > 0 && (!adminPicked || confirmAdmin);
  return (
    <Dialog title="Invite employee" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(await onSubmit({ firstName, lastName, email: email.trim(), roleIds, confirmAdmin }));
          setBusy(false);
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="inv-first" className="mb-1 block text-xs font-medium text-black">First name</label>
            <input id="inv-first" value={firstName} onChange={(e) => setFirst(e.target.value)} className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-black" />
          </div>
          <div>
            <label htmlFor="inv-last" className="mb-1 block text-xs font-medium text-black">Last name</label>
            <input id="inv-last" value={lastName} onChange={(e) => setLast(e.target.value)} className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-black" />
          </div>
        </div>
        <div>
          <label htmlFor="inv-email" className="mb-1 block text-xs font-medium text-black">Email</label>
          <input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-black" />
        </div>
        <RolePicker roles={roles} selected={roleIds} onChange={setRoleIds} />
        {adminPicked && <AdminConfirm checked={confirmAdmin} onChange={setConfirmAdmin} />}
        <p className="text-xs text-black">They&apos;ll get an email with a link to choose a password.</p>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primary} disabled={!valid || busy}>
            {busy ? "Sending…" : "Send invite"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EmployeeRolesDialog({ emp, roles, onClose, onSubmit }: { emp: Employee; roles: Role[]; onClose: () => void; onSubmit: (ids: string[], confirmAdmin: boolean) => Promise<string | null> }) {
  const [roleIds, setRoleIds] = useState(emp.roles.map((r) => r.id));
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addingAdmin = roles.some((r) => r.isAdmin && roleIds.includes(r.id) && !emp.roles.some((x) => x.id === r.id));
  return (
    <Dialog title={`Roles for ${nameOf(emp)}`} onClose={onClose}>
      <div className="space-y-3">
        <RolePicker roles={roles} selected={roleIds} onChange={setRoleIds} />
        {addingAdmin && <AdminConfirm checked={confirmAdmin} onChange={setConfirmAdmin} />}
        <p className="text-xs text-black">Changes apply on their next page load.</p>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <button className={btn} onClick={onClose}>
            Cancel
          </button>
          <button
            className={primary}
            disabled={busy || roleIds.length === 0 || (addingAdmin && !confirmAdmin)}
            onClick={async () => {
              setBusy(true);
              setError(await onSubmit(roleIds, confirmAdmin));
              setBusy(false);
            }}
          >
            Save roles
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function DeleteAccountDialog({ emp, onClose, onSubmit }: { emp: Employee; onClose: () => void; onSubmit: (confirmEmail: string) => Promise<string | null> }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = !!emp.email && typed.trim().toLowerCase() === emp.email.toLowerCase();
  return (
    <Dialog title={`Delete ${nameOf(emp)}'s account?`} onClose={onClose}>
      <div className="space-y-3 text-sm text-black">
        <p data-testid="delete-warning">
          This permanently deletes the login. {emp.email} will no longer be able to sign in and the password is erased. Their name stays on past
          records because compliance logs must remain intact.
        </p>
        <div>
          <label htmlFor="del-confirm" className="mb-1 block text-xs font-medium text-black">
            Type {emp.email} to confirm
          </label>
          <input id="del-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-black" />
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <button className={btn} onClick={onClose}>
            Cancel
          </button>
          <button
            className={danger}
            disabled={!matches || busy}
            onClick={async () => {
              setBusy(true);
              setError(await onSubmit(typed.trim()));
              setBusy(false);
            }}
          >
            Delete account
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function RoleEditor({ role, onClose, onSubmit }: { role: Role | null; onClose: () => void; onSubmit: (i: { name: string; description: string; features: string[] }) => Promise<string | null> }) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [features, setFeatures] = useState<string[]>(role?.features ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useMemo(() => previewSidebarLabels(features), [features]);
  const toggle = (k: string, on: boolean) => setFeatures((f) => (on ? Array.from(new Set([...f, k])) : f.filter((x) => x !== k)));
  return (
    <Dialog title={role ? `Edit role: ${role.name}` : "New role"} onClose={onClose} wide>
      <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
        <div className="space-y-3">
          <div>
            <label htmlFor="role-name" className="mb-1 block text-xs font-medium text-black">Name</label>
            <input id="role-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-black" />
          </div>
          <div>
            <label htmlFor="role-desc" className="mb-1 block text-xs font-medium text-black">Description</label>
            <input id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-black" />
          </div>
          {FEATURE_GROUPS.map((g) => {
            const items = FEATURES.filter((f) => f.group === g && f.assignable);
            const all = items.every((f) => features.includes(f.key));
            return (
              <fieldset key={g} className="rounded-md border border-zinc-200 p-2" data-testid={`group-${g}`}>
                <legend className="px-1 text-sm font-semibold text-black">{g}</legend>
                <label className="mb-1 flex items-center gap-2 text-xs font-medium text-black">
                  <input type="checkbox" className="h-4 w-4" checked={all} onChange={(e) => items.forEach((f) => toggle(f.key, e.target.checked))} />
                  Select all
                </label>
                {items.map((f) => (
                  <label key={f.key} className="flex items-start gap-2 py-0.5 text-sm text-black">
                    <input type="checkbox" className="mt-0.5 h-4 w-4" checked={features.includes(f.key)} onChange={(e) => toggle(f.key, e.target.checked)} aria-label={f.label} />
                    <span>
                      <span className="font-medium">{f.label}</span>
                      <span className="block text-xs">{f.description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            );
          })}
          <p className="text-xs text-black">{ADMIN_ONLY_NOTE}</p>
        </div>
        <aside className="rounded-md bg-zinc-50 p-3 text-sm text-black" aria-label="Sidebar preview" data-testid="sidebar-preview">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-black">Sidebar preview</h3>
          <p className="mt-1 text-xs">Dashboard, Schedule and Alerts, plus:</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {preview.length === 0 && <li>Nothing else</li>}
            {preview.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {role && (
            <p className="mt-3 text-xs" data-testid="affected">
              This change affects {role.employeeCount} employee{role.employeeCount === 1 ? "" : "s"}, on their next page load.
            </p>
          )}
        </aside>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="mt-3 flex justify-end gap-2">
        <button className={btn} onClick={onClose}>
          Cancel
        </button>
        <button
          className={primary}
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            setError(await onSubmit({ name: name.trim(), description, features }));
            setBusy(false);
          }}
        >
          {role ? "Save role" : "Create role"}
        </button>
      </div>
    </Dialog>
  );
}
