import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { updateLink } from "@/lib/procurement/service";
import { actorName, procurementDb, procurementError, readJson } from "@/lib/procurement/routeHelpers";

/** Edit a raw material's supplier link: { link, supplier?, make_preferred? }. */
export async function POST(request: Request, { params }: { params: Promise<{ linkId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { linkId } = await params;
    const body = await readJson(request);
    return NextResponse.json({ link: await updateLink(procurementDb(), linkId, body, actorName(request)) });
  } catch (error) {
    return procurementError(error);
  }
}
