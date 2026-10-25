/**
 * PDF export for a Compliance Log's entries page. Uses jsPDF directly —
 * the same library the Stats page's "Download PDF" already depends on
 * (dynamically imported client-side, never bundled into the main chunk) —
 * but draws real text rows instead of screenshotting the DOM with
 * html2canvas. A log's entries table can run to hundreds of rows, and an
 * image-sliced PDF cuts rows in half at arbitrary page boundaries; this
 * tracks a running Y position and only breaks to a new page between whole
 * entries (or, for a single very long entry, between its field lines), so
 * no row is ever split across a page.
 */

import type { LogEntry, LogEntryFile, LogType } from "@/lib/complianceLogs";
import { isLateEntry } from "@/lib/complianceLogs";

const PAGE_MARGIN = 40;
const LINE_HEIGHT = 14;
const ENTRY_GAP = 10;

function formatValueForDisplay(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  return String(value);
}

export async function generateLogEntriesPdf(opts: {
  logType: Pick<LogType, "name" | "slug">;
  dateFrom: string;
  dateTo: string;
  entries: LogEntry[];
  filesByEntryId: Map<string, LogEntryFile[]>;
  reviewedEntryIds: Set<string>;
  correctedEntryIds: Set<string>;
}): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const contentWidth = pageWidth - PAGE_MARGIN * 2;

  let y = PAGE_MARGIN;

  const ensureSpace = (neededHeight: number) => {
    if (y + neededHeight > pageHeight - PAGE_MARGIN) {
      pdf.addPage();
      y = PAGE_MARGIN;
    }
  };

  const writeLine = (text: string, opts2?: { bold?: boolean; size?: number; color?: [number, number, number] }) => {
    pdf.setFont("helvetica", opts2?.bold ? "bold" : "normal");
    pdf.setFontSize(opts2?.size ?? 10);
    if (opts2?.color) pdf.setTextColor(...opts2.color);
    else pdf.setTextColor(0, 0, 0);
    const wrapped = pdf.splitTextToSize(text, contentWidth) as string[];
    for (const line of wrapped) {
      ensureSpace(LINE_HEIGHT);
      pdf.text(line, PAGE_MARGIN, y);
      y += LINE_HEIGHT;
    }
  };

  // Header — log name, date range, generated date.
  writeLine(opts.logType.name, { bold: true, size: 16 });
  const rangeLabel =
    opts.dateFrom || opts.dateTo
      ? `Date range: ${opts.dateFrom || "earliest"} – ${opts.dateTo || "latest"}`
      : "Date range: all entries";
  writeLine(rangeLabel, { size: 10 });
  writeLine(`Generated ${new Date().toLocaleString()}`, { size: 10 });
  y += ENTRY_GAP;

  if (opts.entries.length === 0) {
    writeLine("No entries match the selected filters.");
  }

  for (const entry of opts.entries) {
    // Estimate this entry's height so we can break to a new page *before*
    // starting it, rather than letting the header line land alone at the
    // bottom of a page.
    const fieldCount = entry.template_snapshot?.fields?.length ?? 0;
    const files = opts.filesByEntryId.get(entry.id) ?? [];
    const estimatedLines = 2 + fieldCount + (files.length ? 1 + files.length : 0) + (entry.is_out_of_spec ? 2 : 0);
    ensureSpace(Math.min(estimatedLines, 6) * LINE_HEIGHT + ENTRY_GAP);
    if (y !== PAGE_MARGIN) y += ENTRY_GAP;

    const late = isLateEntry(entry.performed_at, entry.created_at);
    const badges = [
      entry.is_out_of_spec ? "OUT OF SPEC" : null,
      late ? "LATE ENTRY" : null,
      opts.correctedEntryIds.has(entry.id) ? "CORRECTED" : null,
      opts.reviewedEntryIds.has(entry.id) ? "REVIEWED" : null,
    ].filter(Boolean);

    writeLine(
      `Entry #${entry.entry_number} — ${new Date(entry.performed_at).toLocaleString()} — ${entry.performed_by_name}` +
        (badges.length ? `  [${badges.join(", ")}]` : ""),
      { bold: true, size: 11 },
    );

    for (const field of entry.template_snapshot?.fields ?? []) {
      const value = formatValueForDisplay(entry.values?.[field.key]);
      writeLine(`  ${field.label}${field.unit ? ` (${field.unit})` : ""}: ${value}`);
    }

    if (entry.is_out_of_spec && entry.corrective_action) {
      writeLine(`  Corrective action: ${entry.corrective_action}`, { color: [180, 30, 30] });
    }

    if (files.length) {
      writeLine(`  Attached files:`);
      for (const file of files) {
        writeLine(`    - ${file.original_filename}${file.label ? ` (${file.label})` : ""}`);
      }
    }
  }

  const scopeLabel = opts.dateFrom || opts.dateTo ? `${opts.dateFrom || "start"}_${opts.dateTo || "end"}` : "all";
  pdf.save(`${opts.logType.slug}-entries-${scopeLabel}.pdf`);
}
