import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createClaim } from "@/lib/growth/marketingService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** New claim (draft, or { submit: true } to send it for review). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ claim: await createClaim(growthDb(), await readJson(request), actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
