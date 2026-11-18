import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { syncFromLibrary } from "@/lib/growth/libraryService";
import { growthDb, growthError } from "@/lib/growth/routeHelpers";

/** Update a calendar entry from its library item (not once Posted). */
export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { postId } = await params;
    return NextResponse.json(await syncFromLibrary(growthDb(), postId));
  } catch (error) {
    return growthError(error);
  }
}
