import { guardApi } from "@/lib/access/api";
import { readBody, runAdmin } from "@/lib/access/adminRoute";
import { setEmployeeActive } from "@/lib/access/adminOps";

/** Deactivate ({ active: false }) or reactivate ({ active: true }). */
export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { accountId } = await params;
  const body = await readBody<{ active?: boolean }>(request);
  return runAdmin(request, ({ db, actor }) => setEmployeeActive(db, actor, accountId, body.active === true));
}
