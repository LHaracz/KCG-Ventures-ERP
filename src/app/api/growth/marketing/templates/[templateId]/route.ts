import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { saveTemplate } from "@/lib/growth/marketingService";
import { growthDb, growthError, readJson } from "@/lib/growth/routeHelpers";

/** Edit, archive or restore a caption template. */
export async function POST(request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { templateId } = await params;
    await saveTemplate(growthDb(), templateId, await readJson(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return growthError(error);
  }
}
