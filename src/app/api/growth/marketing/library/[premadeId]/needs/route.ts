import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { needsAction } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Needs on one item: attach, unlink, add, remove, attach_asset, detach_asset. */
export async function POST(request: Request, { params }: { params: Promise<{ premadeId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { premadeId } = await params;
    return NextResponse.json(await needsAction(growthDb(), premadeId, await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
