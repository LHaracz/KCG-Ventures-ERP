import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { savePost } from "@/lib/growth/marketingService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** New post (checks the Ready gate). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await savePost(growthDb(), null, await readJson(request), actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
