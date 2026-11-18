import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveGoal } from "@/lib/growth/prospectingService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** The retailer goal: { goal_retailers, goal_date }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await saveGoal(growthDb(), await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
