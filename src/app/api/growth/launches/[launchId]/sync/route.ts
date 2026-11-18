import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { syncFromFormula } from "@/lib/growth/launches";
import { actorName, growthDb, growthError } from "@/lib/growth/routeHelpers";

/** Sync the ingredient rows from the product's formula. */
export async function POST(request: Request, { params }: { params: Promise<{ launchId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { launchId } = await params;
    return NextResponse.json(await syncFromFormula(growthDb(), launchId, actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
