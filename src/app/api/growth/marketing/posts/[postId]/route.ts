import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { archivePost, savePost } from "@/lib/growth/marketingService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Save a post (checks the Ready gate), or { archive: true } / { restore: true }. */
export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { postId } = await params;
    const body = await readJson(request);
    if (body.archive === true || body.restore === true) {
      await archivePost(growthDb(), postId, body.archive === true);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json(await savePost(growthDb(), postId, body, actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
