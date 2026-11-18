import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { rawMaterialNames, tagsFromRawMaterials } from "@/lib/growth/libraryService";
import { actorName, growthDb, growthError, readJson, requireAdminCaller } from "@/lib/growth/routeHelpers";

/** Admin only: raw material names (names only). */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    requireAdminCaller(request);
    return NextResponse.json({ names: await rawMaterialNames(growthDb()) });
  } catch (error) {
    return growthError(error);
  }
}

/** Admin only: create ingredient tags from chosen raw material names. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    requireAdminCaller(request);
    return NextResponse.json(await tagsFromRawMaterials(growthDb(), await readJson(request), actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
