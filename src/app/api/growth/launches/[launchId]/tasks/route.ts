import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { addTask } from "@/lib/growth/launches";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Add a task: { title, phase, owner_account_id, due_date, notes }. */
export async function POST(request: Request, { params }: { params: Promise<{ launchId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { launchId } = await params;
    return NextResponse.json({ task: await addTask(growthDb(), launchId, await readJson(request)) });
  } catch (error) {
    return growthError(error);
  }
}
