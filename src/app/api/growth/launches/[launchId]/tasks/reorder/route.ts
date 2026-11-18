import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { reorderTasks } from "@/lib/growth/launches";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** New task order: { ids } (every open task, in order). */
export async function POST(request: Request, { params }: { params: Promise<{ launchId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { launchId } = await params;
    const body = await readJson(request);
    await reorderTasks(growthDb(), launchId, body.ids);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
