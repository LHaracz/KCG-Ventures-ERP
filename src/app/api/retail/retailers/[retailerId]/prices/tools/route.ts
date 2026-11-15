import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { runPriceTool, type PriceTool } from "@/lib/retail/service";
import { actorName, readJson, retailDb, retailError } from "@/lib/retail/routeHelpers";

/** Price list helpers: { tool, percent?, source_retailer_id?, overwrite?, apply }. Without apply it only previews. */
export async function POST(request: Request, { params }: { params: Promise<{ retailerId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    const { retailerId } = await params;
    const body = await readJson(request);
    const changes = await runPriceTool(retailDb(), retailerId, body as unknown as PriceTool, body.apply === true, actorName(request));
    return NextResponse.json({ changes, applied: body.apply === true });
  } catch (error) {
    return retailError(error);
  }
}
