import { guardApi } from "@/lib/access/api";
import { readBody, runAdmin } from "@/lib/access/adminRoute";
import { inviteEmployee, listEmployees, type InviteInput } from "@/lib/access/adminOps";

/** Employees list (Admin only). */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  return runAdmin(request, async ({ db }) => ({ employees: await listEmployees(db) }));
}

/** Invite an employee (Admin only). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const body = await readBody<InviteInput>(request);
  return runAdmin(request, ({ db, auth, actor, origin }) => inviteEmployee(db, auth, actor, origin, body));
}
