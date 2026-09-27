import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { runCsvSalesImport } from "@/lib/salesImport";

type ImportCsvRequestBody = {
  csv?: string;
};

// Generous cap on the raw CSV text — a full multi-year order history export
// should still land comfortably under this.
const MAX_CSV_LENGTH = 20 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    await requireApiUserFromBearerToken(request);

    let body: ImportCsvRequestBody = {};
    try {
      const text = await request.text();
      if (text.trim()) body = JSON.parse(text) as ImportCsvRequestBody;
    } catch {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }

    const csv = body.csv;
    if (!csv || !csv.trim()) {
      return NextResponse.json({ error: "No CSV content received." }, { status: 400 });
    }
    if (csv.length > MAX_CSV_LENGTH) {
      return NextResponse.json(
        { error: "CSV file is too large. Try exporting a narrower date range and uploading it in parts." },
        { status: 400 },
      );
    }

    const result = await runCsvSalesImport(csv);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
