import { NextResponse } from "next/server";
import { readJson, withSopApi } from "@/lib/sopApi";
import { publishDraft } from "@/lib/sopService";
import { callerOf, guardApi } from "@/lib/access/api";

/**
 * Publishes the SOP's saved draft as a new immutable version (one
 * transaction in the database: version n+1 with content + frozen formula
 * snapshot, set current, rewrite sop_formula_refs, clear the draft).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardApi(request);
  if (denied) return denied;
  return withSopApi(request, async ({ admin, user }) => {
    const { id } = await params;
    const body = await readJson<{ changeNote: string; effectiveDate: string; expectedRevision: number }>(request);
    // "Published by" is the signed-in employee, from the session.
    const { access } = callerOf(request);
    const result = await publishDraft(admin, {
      sopId: id,
      userId: user.id,
      changeNote: String(body.changeNote ?? ""),
      effectiveDate: String(body.effectiveDate ?? ""),
      publishedByName: access.fullName ?? "",
      expectedRevision: Number(body.expectedRevision),
    });
    return NextResponse.json(result);
  });
}
