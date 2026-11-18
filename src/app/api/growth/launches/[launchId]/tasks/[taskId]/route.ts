import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { updateTask } from "@/lib/growth/launches";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Edit a task, or { archive: true } to remove it (archived, never deleted). */
export async function POST(request: Request, { params }: { params: Promise<{ launchId: string; taskId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { launchId, taskId } = await params;
    return NextResponse.json({ task: await updateTask(growthDb(), launchId, taskId, await readJson(request), actorName(request)) });
  } catch (error) {
    return growthError(error);
  }
}
