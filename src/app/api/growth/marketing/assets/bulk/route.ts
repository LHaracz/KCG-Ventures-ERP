import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { assetBulk } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Bulk on selected assets: set category and tags, set status, archive. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await assetBulk(growthDb(), await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
