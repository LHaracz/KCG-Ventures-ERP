import { guardApi } from "@/lib/access/api";
import { runAdmin } from "@/lib/access/adminRoute";
import { deleteUnrecognized } from "@/lib/access/adminOps";

export async function DELETE(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  const { userId } = await params;
  return runAdmin(request, ({ db, auth, actor, actorName }) => deleteUnrecognized(db, auth, actor, actorName, userId));
}
