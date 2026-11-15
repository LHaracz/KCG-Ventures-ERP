/**
 * Server only: renders an invoice to PDF bytes with the business logo from
 * storage. A missing or unreadable logo is never fatal (the display name
 * prints instead).
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { downloadCompanyLogoBytes } from "@/lib/companyLogoStorage";
import { InvoicePdfDocument } from "@/lib/pdf/invoicePdf";
import type { InvoiceWithLines } from "./types";

export async function renderInvoicePdf(invoice: InvoiceWithLines): Promise<Buffer> {
  let logoDataUri: string | null = null;
  const logoPath = invoice.company_snapshot.logo_path;
  if (logoPath) {
    try {
      const logo = await downloadCompanyLogoBytes(logoPath);
      if (logo) logoDataUri = `data:${logo.mimeType};base64,${Buffer.from(logo.bytes).toString("base64")}`;
    } catch {
      logoDataUri = null;
    }
  }
  const doc = createElement(InvoicePdfDocument, { invoice, logoDataUri });
  return renderToBuffer(doc as unknown as Parameters<typeof renderToBuffer>[0]);
}

export function pdfResponseHeaders(filename: string, asciiName: string, inline: boolean, length: number): Record<string, string> {
  return {
    "Content-Type": "application/pdf",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Content-Length": String(length),
    "Cache-Control": "no-store",
  };
}
