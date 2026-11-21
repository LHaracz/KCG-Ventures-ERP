import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { captionHistory, updateCaption } from "@/lib/growth/libraryService";
import { actorName, growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** The last 10 earlier captions of a library post. */
export async function GET(request: Request, { params }: { params: Promise<{ premadeId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { premadeId } = await params;
    return NextResponse.json({ versions: await captionHistory(growthDb(), premadeId) });
  } catch (error) {
    return growthError(error);
  }
}

/** Edit caption: { caption, expected_updated_at, source? }. Changes only the caption; returns { conflict } if the post changed. */
export async function POST(request: Request, { params }: { params: Promise<{ premadeId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { premadeId } = await params;
    return NextResponse.json(await updateCaption(growthDb(), premadeId, await readJson(request), actorName(request)));
  } catch (error) {
    return growthError(error);
  }
}
