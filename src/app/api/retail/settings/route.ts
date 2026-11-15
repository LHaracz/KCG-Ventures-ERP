import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveSettings } from "@/lib/retail/service";
import { actorName, readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Save one business's invoice settings: { company_profile_id, settings }. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    return NextResponse.json({ settings: await saveSettings(retailDb(), body.company_profile_id, body.settings, actorName(request)) });
  } catch (error) {
    return retailError(error);
  }
}
