import { NextResponse } from "next/server";
import { guardApi } from "@/lib/access/api";
import { convertToRetailer } from "@/lib/growth/prospectingService";
import { actorName, growthDb, growthError, readJson, requireAdminCaller } from "@/lib/growth/routeHelpers";

/** Convert to retailer (Admin only): { confirm_duplicate?, confirm_not_won? }. */
export async function POST(request: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  try {
    requireAdminCaller(request);
    const { leadId } = await params;
    const body = await readJson(request);
    return NextResponse.json(
      await convertToRetailer(growthDb(), leadId, { confirmDuplicate: body.confirm_duplicate === true, confirmNotWon: body.confirm_not_won === true }, actorName(request)),
    );
  } catch (error) {
    return growthError(error);
  }
}
