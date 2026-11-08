import { guardApi } from "@/lib/access/api";
import { readBody, runAdmin } from "@/lib/access/adminRoute";
import { deleteAccount } from "@/lib/access/adminOps";

/** Delete account (also Retry after a failed login deletion). Body: { confirmEmail }. */
export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { accountId } = await params;
  const body = await readBody<{ confirmEmail?: string }>(request);
  return runAdmin(request, ({ db, auth, actor }) => deleteAccount(db, auth, actor, accountId, body.confirmEmail ?? ""));
}
