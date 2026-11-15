"use client";

/**
 * Browser calls to /api/retail (Admin only). Writes always go through these
 * server routes, which check access and validate. Field errors are kept so
 * forms can show them next to the right field.
 */
import { supabase } from "@/lib/supabaseClient";
import type { OrderConflict, PriceChange, RetailBootstrap, RetailerDetail } from "./service";
import type { InvoiceListRow, InvoiceSettings, InvoiceWithLines, Retailer, RetailerPriceRow, Invoice } from "./types";

export type FieldErrors = Record<string, string>;

export class RetailApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly fields: FieldErrors | null,
    public readonly conflict: OrderConflict | null,
  ) {
    super(message);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return { Authorization: `Bearer ${data.session?.access_token ?? ""}` };
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: { ...(await authHeader()), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; fields?: FieldErrors | null; conflict?: OrderConflict | null };
  if (!res.ok) throw new RetailApiError(json.error || `Request failed (${res.status}).`, res.status, json.fields ?? null, json.conflict ?? null);
  return json as T;
}

async function pdf(path: string, body?: unknown): Promise<Blob> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: { ...(await authHeader()), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string; fields?: FieldErrors | null };
    throw new RetailApiError(json.error || `Could not make the PDF (${res.status}).`, res.status, json.fields ?? null, null);
  }
  return res.blob();
}

const enc = encodeURIComponent;

export const fetchRetail = () => call<RetailBootstrap>("/api/retail");
export const saveSettingsApi = (company_profile_id: string, settings: unknown) =>
  call<{ settings: InvoiceSettings }>("/api/retail/settings", { company_profile_id, settings });

export const createRetailerApi = (retailer: unknown, terms: unknown) => call<{ retailer: Retailer }>("/api/retail/retailers", { retailer, terms });
export const updateRetailerApi = (id: string, retailer: unknown, terms: unknown) =>
  call<{ retailer: Retailer }>(`/api/retail/retailers/${enc(id)}`, { retailer, terms });
export const fetchRetailerDetail = (id: string) => call<RetailerDetail>(`/api/retail/retailers/${enc(id)}`);
export const archiveRetailerApi = (id: string) => call<{ retailer: Retailer }>(`/api/retail/retailers/${enc(id)}/archive`, {});
export const restoreRetailerApi = (id: string) => call<{ retailer: Retailer }>(`/api/retail/retailers/${enc(id)}/restore`, {});
export const savePricesApi = (id: string, prices: unknown[]) => call<{ prices: RetailerPriceRow[] }>(`/api/retail/retailers/${enc(id)}/prices`, { prices });
export const priceToolApi = (id: string, tool: Record<string, unknown>, apply: boolean) =>
  call<{ changes: PriceChange[]; applied: boolean }>(`/api/retail/retailers/${enc(id)}/prices/tools`, { ...tool, apply });

export type InvoiceListQuery = { q?: string; business?: string; retailer?: string; terms?: string; from?: string; to?: string; deleted?: boolean; page?: number };
export function fetchInvoices(q: InvoiceListQuery) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === "" || v === false) continue;
    sp.set(k, v === true ? "1" : String(v));
  }
  return call<{ rows: InvoiceListRow[]; total: number; page: number; pageSize: number }>(`/api/retail/invoices?${sp.toString()}`);
}
export const fetchInvoice = (id: string) => call<{ invoice: InvoiceWithLines }>(`/api/retail/invoices/${enc(id)}`);
export const createInvoiceApi = (invoice: unknown) => call<{ id: string; invoice_number: string }>("/api/retail/invoices", { invoice });
export const updateInvoiceApi = (id: string, invoice: unknown) => call<{ id: string; invoice_number: string }>(`/api/retail/invoices/${enc(id)}`, { invoice });
export const deleteInvoiceApi = (id: string) => call<{ invoice: Invoice }>(`/api/retail/invoices/${enc(id)}/delete`, {});
export const restoreInvoiceApi = (id: string) => call<{ invoice: Invoice }>(`/api/retail/invoices/${enc(id)}/restore`, {});
export const checkOrderApi = (order_number: string, exclude_id: string | null) =>
  call<{ normalized: string | null; conflict: OrderConflict | null; message: string | null }>("/api/retail/invoices/check-order", { order_number, exclude_id });

export const invoicePdfBlob = (id: string, inline: boolean) => pdf(`/api/retail/invoices/${enc(id)}/pdf${inline ? "?disposition=inline" : ""}`);
export const previewPdfBlob = (invoice: unknown, existingId: string | null) => pdf("/api/retail/invoices/preview", { invoice, existing_id: existingId });

/** Saves a blob with a filename (no new tab). */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Prints a PDF blob through a hidden frame (the browser's print dialog). */
export function printBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, "_blank", "noopener");
    }
  };
  document.body.appendChild(frame);
  setTimeout(() => {
    frame.remove();
    URL.revokeObjectURL(url);
  }, 120_000);
}
