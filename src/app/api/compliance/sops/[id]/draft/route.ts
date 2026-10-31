import { NextResponse } from "next/server";
import { jsonError, readJson, withSopApi } from "@/lib/sopApi";
import { validateSopDocument } from "@/lib/sopDocument";

/**
 * One autosaved draft per SOP, stored on the sops row.
 * GET    -> the draft (or null), its revision, and the current published version id
 * PUT    -> save with optimistic concurrency: { content, expectedRevision, baseVersionId }
 *           409 { code: "draft_conflict" } when another session saved first
 * DELETE -> discard the draft (?expectedRevision=n). The published version is never affected.
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSopApi(request, async ({ admin }) => {
    const { id } = await params;
    const { data: sop, error } = await admin
      .from("sops")
      .select("id, title, sop_number, description, format, product_id, archived_at, draft_content, draft_revision, draft_updated_at, draft_base_version_id")
      .eq("id", id)
      .maybeSingle();
    if (error) return jsonError(error.message, 500);
    if (!sop) return jsonError("SOP not found.", 404);
    const { data: current } = await admin
      .from("sop_versions")
      .select("id, version_number, content")
      .eq("sop_id", id)
      .eq("is_current", true)
      .maybeSingle();
    return NextResponse.json({
      sop: {
        id: sop.id,
        title: sop.title,
        sop_number: sop.sop_number,
        description: sop.description,
        format: sop.format,
        product_id: sop.product_id,
        archived_at: sop.archived_at,
      },
      draft: sop.draft_content,
      revision: sop.draft_revision,
      draftUpdatedAt: sop.draft_updated_at,
      draftBaseVersionId: sop.draft_base_version_id,
      currentVersion: current ? { id: current.id, version_number: current.version_number, content: current.content } : null,
    });
  });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSopApi(request, async ({ admin, user }) => {
    const { id } = await params;
    const body = await readJson<{ content: unknown; expectedRevision: number; baseVersionId?: string | null }>(request);
    if (!Number.isInteger(body.expectedRevision)) return jsonError("expectedRevision is required.");
    const valid = validateSopDocument(body.content);
    if (!valid.ok) return jsonError(valid.error);

    const nowIso = new Date().toISOString();
    // Single conditional UPDATE: succeeds only if nobody saved since expectedRevision.
    const { data, error } = await admin
      .from("sops")
      .update({
        draft_content: valid.doc,
        draft_revision: body.expectedRevision + 1,
        draft_updated_at: nowIso,
        draft_updated_by: user.id,
        draft_base_version_id: body.baseVersionId ?? null,
      })
      .eq("id", id)
      .eq("draft_revision", body.expectedRevision)
      .select("draft_revision, draft_updated_at");
    if (error) return jsonError(error.message, 500);
    if (!data || data.length === 0) {
      const { data: latest } = await admin.from("sops").select("draft_revision, draft_updated_at").eq("id", id).maybeSingle();
      if (!latest) return jsonError("SOP not found.", 404);
      return jsonError("This SOP was changed in another session.", 409, {
        code: "draft_conflict",
        revision: latest.draft_revision,
        draftUpdatedAt: latest.draft_updated_at,
      });
    }
    return NextResponse.json({ revision: data[0].draft_revision, savedAt: data[0].draft_updated_at });
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSopApi(request, async ({ admin, user }) => {
    const { id } = await params;
    const expected = Number(new URL(request.url).searchParams.get("expectedRevision"));
    if (!Number.isInteger(expected)) return jsonError("expectedRevision is required.");
    const { data, error } = await admin
      .from("sops")
      .update({
        draft_content: null,
        draft_revision: expected + 1,
        draft_updated_at: new Date().toISOString(),
        draft_updated_by: user.id,
        draft_base_version_id: null,
      })
      .eq("id", id)
      .eq("draft_revision", expected)
      .select("draft_revision");
    if (error) return jsonError(error.message, 500);
    if (!data || data.length === 0) return jsonError("This SOP was changed in another session.", 409, { code: "draft_conflict" });
    return NextResponse.json({ revision: data[0].draft_revision });
  });
}
