import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { createPillar } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** New pillar (letter, name, description, recurring). */
export async function POST(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ pillar: await createPillar(growthDb(), await readJson(request)) });
  } catch (error) {
    return growthError(error);
  }
}
