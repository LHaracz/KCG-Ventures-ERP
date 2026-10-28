import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createSignedLogoViewUrl, SIGNED_LOGO_URL_TTL_SECONDS } from "@/lib/companyLogoStorage";

/**
 * Short-lived signed URL for previewing a profile's current logo (the
 * `company-assets` bucket is private, so the settings page can't just point
 * an <img> at the stored path). Never returns a permanent URL — every call
 * mints a fresh one (~10 min).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: profileId } = await params;
    await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Storage is not configured on the server (missing service role key)." },
        { status: 500 },
      );
    }

    const { data: profile, error } = await supabaseAdmin
      .from("company_profiles")
      .select("id, logo_path")
      .eq("id", profileId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!profile) return NextResponse.json({ error: "Business profile not found." }, { status: 404 });
    if (!profile.logo_path) return NextResponse.json({ url: null });

    const url = await createSignedLogoViewUrl(profile.logo_path);
    return NextResponse.json({ url, expiresInSeconds: SIGNED_LOGO_URL_TTL_SECONDS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
