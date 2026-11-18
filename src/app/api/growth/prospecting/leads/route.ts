import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createLead } from "@/lib/growth/prospectingService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Add a lead (quick add or the full editor). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ lead: await createLead(growthDb(), body.lead, actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
