import { guardApi } from "@/lib/access/api";
import { readBody, runAdmin } from "@/lib/access/adminRoute";
import { deleteRole, saveRole } from "@/lib/access/adminOps";

export async function PUT(request: Request, { params }: { params: Promise<{ roleId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { roleId } = await params;
  const body = await readBody<{ name: string; description?: string; features: string[] }>(request);
  return runAdmin(request, async ({ db, actor }) => ({ roleId: await saveRole(db, actor, roleId, body) }));
}

export async function DELETE(request: Request, { params }: { params: Promise<{ roleId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { roleId } = await params;
  return runAdmin(request, ({ db, actor }) => deleteRole(db, actor, roleId));
}
