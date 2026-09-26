import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { runSalesImport } from "@/lib/salesImport";

type ImportRequestBody = {
  since?: string | null;
  until?: string | null;
};

export async function POST(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);

    let body: ImportRequestBody = {};
    try {
      const text = await request.text();
      if (text.trim()) body = JSON.parse(text) as ImportRequestBody;
    } catch {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }

    const result = await runSalesImport({
      since: body.since || null,
      until: body.until || null,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
