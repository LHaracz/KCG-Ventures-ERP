import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { followUpsDue } from "@/lib/growth/prospectingService";
import { growthDb, growthError } from "@/lib/growth/routeHelpers";

/** Dashboard "Follow-ups due": overdue first, at most 10. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ leads: await followUpsDue(growthDb()) });
  } catch (error) {
    return growthError(error);
  }
}
