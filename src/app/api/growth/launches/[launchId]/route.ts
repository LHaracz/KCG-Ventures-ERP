import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { loadLaunchDetail, updateLaunch } from "@/lib/growth/launches";
import { actorName, callerHas, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** A launch with its checklist, ingredient plan and activity. Applies automatic arrivals and automatic tasks first. */
export async function GET(request: Request, { params }: { params: Promise<{ launchId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { launchId } = await params;
    const detail = await loadLaunchDetail(growthDb(), launchId, { actor: actorName(request) });
    return NextResponse.json({ ...detail, can_create_po: callerHas(request, "inventory.purchase_orders") });
  } catch (error) {
    return growthError(error);
  }
}

/** Edit launch fields (name, product, status, dates, units, buffer, notes). */
export async function POST(request: Request, { params }: { params: Promise<{ launchId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { launchId } = await params;
    const body = await readJson(request);
    return NextResponse.json({ launch: await updateLaunch(growthDb(), launchId, body, actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
