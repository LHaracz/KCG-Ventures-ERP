import { guardApi } from "@/lib/access/api";
import { runAdmin } from "@/lib/access/adminRoute";
import { listActivity } from "@/lib/access/adminOps";

/** The latest 50 access_audit_log rows. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  return runAdmin(request, async ({ db }) => ({ activity: await listActivity(db, 50) }));
}
