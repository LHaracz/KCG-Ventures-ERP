import { guardApi } from "@/lib/access/api";
import { readBody, runAdmin } from "@/lib/access/adminRoute";
import { setEmployeeRoles } from "@/lib/access/adminOps";

export async function PUT(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { accountId } = await params;
  const body = await readBody<{ roleIds?: string[]; confirmAdmin?: boolean }>(request);
  return runAdmin(request, ({ db, actor }) => setEmployeeRoles(db, actor, accountId, body.roleIds ?? [], !!body.confirmAdmin));
}
