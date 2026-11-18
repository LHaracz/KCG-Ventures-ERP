import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { tasksDue } from "@/lib/growth/launches";
import { actorAccountId, growthDb, growthError } from "@/lib/growth/routeHelpers";

/** Dashboard "Launch tasks due": open tasks due within 7 days or overdue, mine first, at most 10. */
export async function GET(request: Request) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    return NextResponse.json({ tasks: await tasksDue(growthDb(), { accountId: actorAccountId(request) }) });
  } catch (error) {
    return growthError(error);
  }
}
