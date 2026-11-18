import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadLead, updateLead } from "@/lib/growth/prospectingService";
import { growthDb, growthError, isAdminCaller, readJson } from "@/lib/growth/routeHelpers";

/** A lead with its activity timeline and trips. */
export async function GET(request: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { leadId } = await params;
    return NextResponse.json({ ...(await loadLead(growthDb(), leadId)), is_admin: isAdminCaller(request) });
  } catch (error) {
    return growthError(error);
  }
}

/** Edit a lead or change its status; { archive: true } / { restore: true }. */
export async function POST(request: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { leadId } = await params;
    return NextResponse.json({ lead: await updateLead(growthDb(), leadId, await readJson(request)) });
  } catch (error) {
    return growthError(error);
  }
}
