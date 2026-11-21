import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { markPosted } from "@/lib/growth/libraryService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Mark posted: { posted_url? }. Freezes the final caption and the name into the entry. */
export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { postId } = await params;
    return NextResponse.json(await markPosted(growthDb(), postId, await readJson(request)));
  } catch (error) {
    return growthError(error);
  }
}
