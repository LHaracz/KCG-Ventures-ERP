import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { removeFromCalendar } from "@/lib/growth/libraryService";
import { growthDb, growthError } from "@/lib/growth/routeHelpers";

/** Remove from calendar: archives the group's entries that aren't Posted. */
export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { postId } = await params;
    return NextResponse.json(await removeFromCalendar(growthDb(), postId));
  } catch (error) {
    return growthError(error);
  }
}
