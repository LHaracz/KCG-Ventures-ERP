import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createLaunch, listLaunches } from "@/lib/growth/launches";
import { actorAccountId, actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Launches (with progress, risk and the earliest test batch date), my open tasks, and products for the New launch form. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await listLaunches(growthDb(), { accountId: actorAccountId(request) }));
  } catch (error) {
    return growthError(error);
  }
}

/** New launch: { launch, start_from: "default" | "duplicate" | "blank", duplicate_from_id? }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ launch: await createLaunch(growthDb(), body, actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
