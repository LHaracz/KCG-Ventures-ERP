/**
 * Server only. Active employees for owner / assignee dropdowns: id and name,
 * never emails or roles. employee_accounts is Admin-only for the browser, so
 * this reads it with the service role after the route's feature check.
 */
import { fullNameOf } from "@/lib/access/access";
import type { Db } from "./routeHelpers";

export type AssignableEmployee = { id: string; name: string };

export async function listAssignableEmployees(db: Db): Promise<AssignableEmployee[]> {
  const { data, error } = await db.from("employee_accounts").select("id, first_name, last_name, status").eq("status", "active");
  if (error) throw new Error("Could not load employees.");
  return ((data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>)
    .map((r) => ({ id: r.id, name: fullNameOf(r.first_name, r.last_name) ?? "Unnamed employee" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
