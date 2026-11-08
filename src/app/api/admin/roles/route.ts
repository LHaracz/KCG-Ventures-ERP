import { guardApi } from "@/lib/access/api";
import { readBody, runAdmin } from "@/lib/access/adminRoute";
import { listRoles, saveRole } from "@/lib/access/adminOps";

export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  return runAdmin(request, async ({ db }) => ({ roles: await listRoles(db) }));
}

export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const body = await readBody<{ name: string; description?: string; features: string[] }>(request);
  return runAdmin(request, async ({ db, actor }) => ({ roleId: await saveRole(db, actor, null, body) }));
}
