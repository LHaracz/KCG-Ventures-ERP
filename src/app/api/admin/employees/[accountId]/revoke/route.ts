import { guardApi } from "@/lib/access/api";
import { runAdmin } from "@/lib/access/adminRoute";
import { revokeInvite } from "@/lib/access/adminOps";

export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { accountId } = await params;
  return runAdmin(request, ({ db, auth, actor }) => revokeInvite(db, auth, actor, accountId));
}
