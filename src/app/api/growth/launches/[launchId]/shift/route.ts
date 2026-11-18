import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { shiftLaunchTasks } from "@/lib/growth/launches";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Move every open task with a due date by { days }; optionally { planned_test_batch_date }. */
export async function POST(request: Request, { params }: { params: Promise<{ launchId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { launchId } = await params;
    return NextResponse.json(await shiftLaunchTasks(growthDb(), launchId, await readJson(request), actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
