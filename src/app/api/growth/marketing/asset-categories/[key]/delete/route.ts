import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { deleteAssetCategory } from "@/lib/growth/libraryService";
import { growthDb, growthError } from "@/lib/growth/routeHelpers";

/** Deletes an asset category, only while no asset (archived ones included) uses it. */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { key } = await params;
    return NextResponse.json(await deleteAssetCategory(growthDb(), key));
  } catch (error) {
    return growthError(error);
  }
}
