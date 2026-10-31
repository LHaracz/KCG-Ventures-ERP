import { NextResponse } from "next/server";
import { readJson, withSopApi } from "@/lib/sopApi";
import { publishDraft } from "@/lib/sopService";

/**
 * Publishes the SOP's saved draft as a new immutable version (one
 * transaction in the database: version n+1 with content + frozen formula
 * snapshot, set current, rewrite sop_formula_refs, clear the draft).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSopApi(request, async ({ admin, user }) => {
    const { id } = await params;
    const body = await readJson<{ changeNote: string; effectiveDate: string; publishedByName: string; expectedRevision: number }>(request);
    const result = await publishDraft(admin, {
      sopId: id,
      userId: user.id,
      changeNote: String(body.changeNote ?? ""),
      effectiveDate: String(body.effectiveDate ?? ""),
      publishedByName: String(body.publishedByName ?? ""),
      expectedRevision: Number(body.expectedRevision),
    });
    return NextResponse.json(result);
  });
}
