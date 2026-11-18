import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveTemplate } from "@/lib/growth/marketingService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** New caption template. */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    await saveTemplate(growthDb(), null, await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
