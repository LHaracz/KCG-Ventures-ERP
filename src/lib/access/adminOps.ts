/**
 * Employees and Roles: the server operations behind the Employees page. Every
 * function assumes the caller already passed requireAdmin(); the database
 * functions it calls are executable by the service role only.
 *
 * `auth` is Supabase's admin auth API (supabaseAdmin.auth); tests pass a mock.
 */
import { FEATURES, isFeatureKey } from "@/lib/access/catalog";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;
export type AuthApi = {
  admin: {
    inviteUserByEmail: (email: string, opts: { redirectTo?: string; data?: Record<string, unknown> }) => Promise<{ data: { user: { id: string } | null } | null; error: { message: string } | null }>;
    deleteUser: (id: string) => Promise<{ error: { message: string } | null }>;
    listUsers: (opts: { page: number; perPage: number }) => Promise<{ data: { users: Array<{ id: string; email?: string | null; created_at?: string; last_sign_in_at?: string | null }> } | null; error: { message: string } | null }>;
  };
  resetPasswordForEmail: (email: string, opts: { redirectTo?: string }) => Promise<{ error: { message: string } | null }>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export class OpError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
  }
}

const rpc = async (db: Db, fn: string, args: Record<string, unknown>) => {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const code = error.hint || "db_error";
    const status = code === "db_error" ? 500 : code === "not_found" || code === "role_not_found" ? 404 : code === "last_admin" || code === "role_in_use" || code === "email_exists" || code === "name_taken" ? 409 : 400;
    throw new OpError(error.message, status, code);
  }
  return data;
};

export const acceptInviteUrl = (origin: string) => `${origin.replace(/\/$/, "")}/auth/accept-invite`;

/** Finds a login by email (case-insensitive), paging through the users. */
export async function findAuthUserByEmail(auth: AuthApi, email: string) {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new OpError(`Couldn't read sign-in accounts: ${error.message}`, 502, "auth_error");
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

export async function listAllAuthUsers(auth: AuthApi) {
  const all: Array<{ id: string; email?: string | null; created_at?: string; last_sign_in_at?: string | null }> = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new OpError(`Couldn't read sign-in accounts: ${error.message}`, 502, "auth_error");
    const users = data?.users ?? [];
    all.push(...users);
    if (users.length < 200) break;
  }
  return all;
}

// --- Employees ---------------------------------------------------------------
export type EmployeeRow = {
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

export async function listEmployees(db: Db): Promise<EmployeeRow[]> {
  const [{ data: accounts, error: e1 }, { data: links, error: e2 }, { data: roles, error: e3 }] = await Promise.all([
    db.from("employee_accounts").select("id, first_name, last_name, email, status, invited_at, accepted_at, auth_delete_pending_user_id"),
    db.from("employee_roles").select("employee_id, role_id"),
    db.from("roles").select("id, name, is_admin"),
  ]);
  const err = e1 ?? e2 ?? e3;
  if (err) throw new OpError(err.message, 500, "db_error");
  const roleById = new Map((roles ?? []).map((r: { id: string; name: string; is_admin: boolean }) => [r.id, r]));
  return ((accounts ?? []) as Array<Record<string, any>>) // eslint-disable-line @typescript-eslint/no-explicit-any
    .filter((a) => a.status !== "deleted" || a.auth_delete_pending_user_id)
    .map((a) => ({
      id: a.id,
      firstName: a.first_name,
      lastName: a.last_name,
      email: a.email,
      status: a.status,
      invitedAt: a.invited_at,
      acceptedAt: a.accepted_at,
      deletePending: !!a.auth_delete_pending_user_id,
      roles: ((links ?? []) as Array<{ employee_id: string; role_id: string }>)
        .filter((l) => l.employee_id === a.id)
        .map((l) => roleById.get(l.role_id) as { id: string; name: string; is_admin: boolean } | undefined)
        .filter((r): r is { id: string; name: string; is_admin: boolean } => !!r)
        .map((r) => ({ id: r.id, name: r.name, isAdmin: r.is_admin }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    }))
    .sort((x, y) => `${x.firstName ?? ""} ${x.lastName ?? ""}`.localeCompare(`${y.firstName ?? ""} ${y.lastName ?? ""}`));
}

async function adminRoleId(db: Db): Promise<string | null> {
  const { data } = await db.from("roles").select("id").eq("is_admin", true).maybeSingle();
  return data?.id ?? null;
}

export type InviteInput = { firstName: string; lastName: string; email: string; roleIds: string[]; confirmAdmin?: boolean };
export type InviteResult = { accountId: string; mode: "invited" | "linked_existing" };

/**
 * Invite: create the 'invited' account and its roles, then send Supabase's
 * invite email. If sending fails, the account is removed again. If the
 * address already has a login with no account (a stray signup), it is linked
 * and sent a password-reset link instead.
 */
export async function inviteEmployee(db: Db, auth: AuthApi, actor: string, origin: string, input: InviteInput): Promise<InviteResult> {
  const first = (input.firstName ?? "").trim();
  const last = (input.lastName ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const roleIds = Array.from(new Set(input.roleIds ?? []));
  if (!first || !last) throw new OpError("First and last name are required.", 400, "name_required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new OpError("Enter a valid email address.", 400, "bad_email");
  if (roleIds.length === 0) throw new OpError("Choose at least one role.", 400, "roles_required");
  const adminId = await adminRoleId(db);
  if (adminId && roleIds.includes(adminId) && !input.confirmAdmin) {
    throw new OpError("Confirm that this person should be an Admin.", 400, "confirm_admin");
  }

  const existing = await findAuthUserByEmail(auth, email);
  if (existing) {
    const { data: linked } = await db.from("employee_accounts").select("id, status").eq("user_id", existing.id).maybeSingle();
    if (linked && linked.status !== "deleted") throw new OpError("Someone with this email already has an account.", 409, "email_exists");
  }

  const accountId = (await rpc(db, "admin_create_invite", {
    p_actor: actor, p_first: first, p_last: last, p_email: email, p_role_ids: roleIds,
  })) as string;

  if (existing) {
    // Stray signup: link it and send a password-reset link instead of an invite.
    const { error } = await auth.resetPasswordForEmail(email, { redirectTo: `${acceptInviteUrl(origin)}?flow=recovery` });
    if (error) {
      await db.rpc("admin_discard_invite", { p_account: accountId });
      throw new OpError(`The reset email could not be sent: ${error.message}`, 502, "send_failed");
    }
    await rpc(db, "admin_finish_invite", { p_actor: actor, p_account: accountId, p_user: existing.id, p_action: "invited", p_note: "linked an existing login; sent a password-reset link" });
    return { accountId, mode: "linked_existing" };
  }

  const { data, error } = await auth.admin.inviteUserByEmail(email, {
    redirectTo: acceptInviteUrl(origin),
    data: { first_name: first, last_name: last },
  });
  if (error || !data?.user) {
    await db.rpc("admin_discard_invite", { p_account: accountId });
    throw new OpError(`The invite email could not be sent: ${error?.message ?? "no user returned"}`, 502, "send_failed");
  }
  await rpc(db, "admin_finish_invite", { p_actor: actor, p_account: accountId, p_user: data.user.id, p_action: "invited" });
  return { accountId, mode: "invited" };
}

async function loadAccount(db: Db, accountId: string) {
  const { data, error } = await db.from("employee_accounts").select("id, user_id, email, status, first_name, last_name, auth_delete_pending_user_id").eq("id", accountId).maybeSingle();
  if (error) throw new OpError(error.message, 500, "db_error");
  if (!data) throw new OpError("Account not found.", 404, "not_found");
  return data as { id: string; user_id: string | null; email: string | null; status: string; first_name: string | null; last_name: string | null; auth_delete_pending_user_id: string | null };
}

/** Resend invite: a fresh login and link (the unused old login is removed). */
export async function resendInvite(db: Db, auth: AuthApi, actor: string, origin: string, accountId: string) {
  const acc = await loadAccount(db, accountId);
  if (acc.status !== "invited" || !acc.email) throw new OpError("Only an invited account can get a new invite.", 400, "not_invited");
  if (acc.user_id) {
    const { error } = await auth.admin.deleteUser(acc.user_id);
    if (error && !/not.?found/i.test(error.message)) throw new OpError(`Couldn't replace the old invite: ${error.message}`, 502, "auth_error");
  }
  const { data, error } = await auth.admin.inviteUserByEmail(acc.email, {
    redirectTo: acceptInviteUrl(origin),
    data: { first_name: acc.first_name, last_name: acc.last_name },
  });
  if (error || !data?.user) throw new OpError(`The invite email could not be sent: ${error?.message ?? "no user returned"}`, 502, "send_failed");
  await rpc(db, "admin_finish_invite", { p_actor: actor, p_account: accountId, p_user: data.user.id, p_action: "invite_resent" });
  return { ok: true };
}

/** Revoke invite: removes the invited login and marks the account deleted. */
export async function revokeInvite(db: Db, auth: AuthApi, actor: string, accountId: string) {
  const acc = await loadAccount(db, accountId);
  if (acc.status !== "invited") throw new OpError("Only an invited account can be revoked.", 400, "not_invited");
  return deleteAccountSteps(db, auth, actor, accountId, "invite_revoked");
}

/** Delete account (the admin typed the account's email to confirm). */
export async function deleteAccount(db: Db, auth: AuthApi, actor: string, accountId: string, confirmEmail: string) {
  const acc = await loadAccount(db, accountId);
  if (acc.status === "deleted") {
    // Retry of a failed login deletion: no email to confirm any more.
    return deleteAccountSteps(db, auth, actor, accountId, "deleted");
  }
  if (!acc.email || acc.email.toLowerCase() !== (confirmEmail ?? "").trim().toLowerCase()) {
    throw new OpError("Type the account's email exactly to confirm.", 400, "confirm_mismatch");
  }
  return deleteAccountSteps(db, auth, actor, accountId, "deleted");
}

async function deleteAccountSteps(db: Db, auth: AuthApi, actor: string, accountId: string, action: "deleted" | "invite_revoked") {
  // Step 1, one transaction: access ends now.
  const r = (await rpc(db, "admin_delete_employee", { p_actor: actor, p_account: accountId, p_action: action })) as { user_id: string | null };
  const userId = r?.user_id ?? null;
  if (!userId) return { ok: true, authDeleted: true };
  // Step 2: delete the Supabase login. On failure the account stays deleted
  // here with the login id kept for Retry.
  const { error } = await auth.admin.deleteUser(userId);
  if (error && !/not.?found/i.test(error.message)) {
    throw new OpError(`Access was removed, but the login could not be deleted: ${error.message}. Use Retry.`, 502, "auth_delete_failed");
  }
  const { error: clearErr } = await db.from("employee_accounts").update({ auth_delete_pending_user_id: null }).eq("id", accountId);
  if (clearErr) throw new OpError(clearErr.message, 500, "db_error");
  return { ok: true, authDeleted: true };
}

export async function setEmployeeRoles(db: Db, actor: string, accountId: string, roleIds: string[], confirmAdmin: boolean) {
  const ids = Array.from(new Set(roleIds ?? []));
  if (ids.length === 0) throw new OpError("Choose at least one role.", 400, "roles_required");
  const adminId = await adminRoleId(db);
  if (adminId && ids.includes(adminId)) {
    const { data } = await db.from("employee_roles").select("role_id").eq("employee_id", accountId).eq("role_id", adminId).maybeSingle();
    if (!data && !confirmAdmin) throw new OpError("Confirm that this person should be an Admin.", 400, "confirm_admin");
  }
  return rpc(db, "admin_set_employee_roles", { p_actor: actor, p_account: accountId, p_role_ids: ids, p_action: "roles_changed" });
}

export async function setEmployeeActive(db: Db, actor: string, accountId: string, active: boolean) {
  return rpc(db, "admin_set_employee_status", { p_actor: actor, p_account: accountId, p_active: active });
}

/** Supabase logins with no employee account. */
export async function listUnrecognized(db: Db, auth: AuthApi) {
  const users = await listAllAuthUsers(auth);
  const { data, error } = await db.from("employee_accounts").select("user_id").not("user_id", "is", null);
  if (error) throw new OpError(error.message, 500, "db_error");
  const known = new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
  return users
    .filter((u) => !known.has(u.id))
    .map((u) => ({ userId: u.id, email: u.email ?? null, createdAt: u.created_at ?? null, lastSignInAt: u.last_sign_in_at ?? null }));
}

export async function deleteUnrecognized(db: Db, auth: AuthApi, actor: string, actorName: string, userId: string) {
  const { data: linked } = await db.from("employee_accounts").select("id").eq("user_id", userId).maybeSingle();
  if (linked) throw new OpError("This login belongs to an employee account. Delete it from the Employees list.", 409, "has_account");
  const users = await listAllAuthUsers(auth);
  const u = users.find((x) => x.id === userId);
  if (!u) throw new OpError("Login not found.", 404, "not_found");
  const { error } = await auth.admin.deleteUser(userId);
  if (error) throw new OpError(`The login could not be deleted: ${error.message}`, 502, "auth_delete_failed");
  await db.from("access_audit_log").insert({
    actor_name: actorName,
    actor_account_id: actor,
    action: "deleted",
    target: u.email ?? "Unrecognized login",
    detail: { unrecognized_login: true },
  });
  return { ok: true };
}

// --- Roles -------------------------------------------------------------------
export type RoleRow = { id: string; name: string; description: string | null; isAdmin: boolean; isSystem: boolean; features: string[]; employeeCount: number };

export async function listRoles(db: Db): Promise<RoleRow[]> {
  const [{ data: roles, error: e1 }, { data: feats, error: e2 }, { data: links, error: e3 }] = await Promise.all([
    db.from("roles").select("id, name, description, is_admin, is_system"),
    db.from("role_features").select("role_id, feature_key"),
    db.from("employee_roles").select("role_id, employee_id"),
  ]);
  const err = e1 ?? e2 ?? e3;
  if (err) throw new OpError(err.message, 500, "db_error");
  return ((roles ?? []) as Array<{ id: string; name: string; description: string | null; is_admin: boolean; is_system: boolean }>)
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isAdmin: r.is_admin,
      isSystem: r.is_system,
      features: ((feats ?? []) as Array<{ role_id: string; feature_key: string }>).filter((f) => f.role_id === r.id).map((f) => f.feature_key).sort(),
      employeeCount: ((links ?? []) as Array<{ role_id: string }>).filter((l) => l.role_id === r.id).length,
    }))
    .sort((a, b) => (a.isAdmin === b.isAdmin ? a.name.localeCompare(b.name) : a.isAdmin ? -1 : 1));
}

export async function saveRole(db: Db, actor: string, roleId: string | null, input: { name: string; description?: string | null; features: string[] }) {
  const features = Array.from(new Set(input.features ?? []));
  const unknown = features.filter((f) => !isFeatureKey(f) || !FEATURES.find((x) => x.key === f)?.assignable);
  if (unknown.length) throw new OpError(`These can't be assigned to a role: ${unknown.join(", ")}.`, 400, "bad_feature");
  return (await rpc(db, "admin_save_role", {
    p_actor: actor, p_role: roleId, p_name: input.name ?? "", p_description: input.description ?? null, p_features: features,
  })) as string;
}

export async function deleteRole(db: Db, actor: string, roleId: string) {
  return rpc(db, "admin_delete_role", { p_actor: actor, p_role: roleId });
}

export async function listActivity(db: Db, limit = 50) {
  const { data, error } = await db
    .from("access_audit_log")
    .select("id, actor_name, action, target, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new OpError(error.message, 500, "db_error");
  return data ?? [];
}
