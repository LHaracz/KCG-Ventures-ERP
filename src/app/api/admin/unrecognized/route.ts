import { guardApi } from "@/lib/access/api";
import { runAdmin } from "@/lib/access/adminRoute";
import { listUnrecognized } from "@/lib/access/adminOps";

/** Supabase logins that have no employee account. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  return runAdmin(request, async ({ db, auth }) => ({ logins: await listUnrecognized(db, auth) }));
}
