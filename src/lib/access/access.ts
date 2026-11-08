/**
 * Loads one login's access from the database (access_for_user), fresh on
 * every call. Nothing is cached in cookies or tokens: deactivating someone or
 * changing a role takes effect on their next request.
 */
import type { AccessSummary, FeatureKey } from "@/lib/access/catalog";
import { hasFeature } from "@/lib/access/catalog";

export type Access = AccessSummary & {
  userId: string;
  accountId: string | null;
  status: "invited" | "active" | "deactivated" | "deleted" | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  roles: string[];
  /** "Jane Doe", or null when the profile has no name yet. */
  fullName: string | null;
};

type AccessRow = {
  account_id: string;
  status: Access["status"];
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  is_admin: boolean;
  roles: string[];
  features: string[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> };

export function fullNameOf(first: string | null | undefined, last: string | null | undefined): string | null {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  return f && l ? `${f} ${l}` : null;
}

/** Access for a login (by auth user id). Throws if the database can't be read (callers deny). */
export async function loadAccess(db: Db, userId: string): Promise<Access> {
  const { data, error } = await db.rpc("access_for_user", { p_user: userId });
  if (error) throw new Error(`Could not check access: ${error.message}`);
  const row = (data ?? null) as AccessRow | null;
  if (!row) {
    return { userId, accountId: null, status: null, email: null, firstName: null, lastName: null, roles: [], fullName: null, active: false, isAdmin: false, features: new Set() };
  }
  const active = row.status === "active";
  return {
    userId,
    accountId: row.account_id,
    status: row.status,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    roles: row.roles ?? [],
    fullName: fullNameOf(row.first_name, row.last_name),
    active,
    isAdmin: active && !!row.is_admin,
    features: new Set(active ? row.features ?? [] : []),
  };
}

export class AccessError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403,
    public readonly code: "unauthorized" | "no_access" | "forbidden",
  ) {
    super(message);
  }
}

export const NO_ACCESS_MESSAGE = "You don't have access to this ERP. Contact an admin.";
export const FORBIDDEN_MESSAGE = "You don't have access to this feature.";

export function requireFeature(access: Access | null, key: FeatureKey): Access {
  if (!access?.active) throw new AccessError(NO_ACCESS_MESSAGE, 403, "no_access");
  if (!hasFeature(access, key)) throw new AccessError(FORBIDDEN_MESSAGE, 403, "forbidden");
  return access;
}
export function requireAnyFeature(access: Access | null, keys: readonly FeatureKey[]): Access {
  if (!access?.active) throw new AccessError(NO_ACCESS_MESSAGE, 403, "no_access");
  if (!keys.some((k) => hasFeature(access, k))) throw new AccessError(FORBIDDEN_MESSAGE, 403, "forbidden");
  return access;
}
export function requireAdmin(access: Access | null): Access {
  if (!access?.active) throw new AccessError(NO_ACCESS_MESSAGE, 403, "no_access");
  if (!access.isAdmin) throw new AccessError(FORBIDDEN_MESSAGE, 403, "forbidden");
  return access;
}
