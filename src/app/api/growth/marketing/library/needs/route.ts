import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { needsGroupAction } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** The Needs panel: attach or unlink one need on the chosen items. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await needsGroupAction(growthDb(), await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
