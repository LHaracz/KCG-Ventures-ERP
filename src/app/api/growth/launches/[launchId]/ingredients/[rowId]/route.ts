import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { ingredientAction } from "@/lib/growth/launches";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Ingredient actions: { action: "supplier" | "ordered" | "arrived" | "undo" | "skip" | "notes", ... }. */
export async function POST(request: Request, { params }: { params: Promise<{ launchId: string; rowId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { launchId, rowId } = await params;
    await ingredientAction(growthDb(), launchId, rowId, await readJson(request), actorName(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
