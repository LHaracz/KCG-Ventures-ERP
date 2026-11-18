"use client";

/** Browser calls for line sheets (Admin only; the server routes check). */
import { supabase } from "@/lib/supabaseClient";
import { RetailApiError, type FieldErrors } from "./client";
import type { LineSheetBuilderData, LineSheetListRow } from "./lineSheetService";
import type { LineSheetWithLines } from "./lineSheets";

async function req(path: string, body?: unknown): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string; fields?: FieldErrors | null };
    throw new RetailApiError(json.error || `Request failed (${res.status}).`, res.status, json.fields ?? null, null);
  }
  return res;
}
const json = async <T>(path: string, body?: unknown) => (await (await req(path, body)).json()) as T;
const enc = encodeURIComponent;
const B = "/api/retail/line-sheets";

export const fetchLineSheets = (deleted = false) => json<{ rows: LineSheetListRow[]; builder: LineSheetBuilderData }>(`${B}${deleted ? "?deleted=1" : ""}`);
export const fetchLineSheet = (id: string) => json<{ sheet: LineSheetWithLines }>(`${B}/${enc(id)}`);
export const createLineSheetApi = (sheet: unknown) => json<{ id: string }>(B, sheet);
export const updateLineSheetApi = (id: string, sheet: unknown) => json<{ id: string }>(`${B}/${enc(id)}`, sheet);
export const duplicateLineSheetApi = (id: string) => json<{ id: string }>(`${B}/${enc(id)}/duplicate`, {});
export const deleteLineSheetApi = (id: string, restore = false) => json<{ ok: true }>(`${B}/${enc(id)}/delete`, restore ? { restore: true } : {});
export const lineSheetPdfBlob = async (id: string, inline: boolean) => (await req(`${B}/${enc(id)}/pdf${inline ? "?disposition=inline" : ""}`)).blob();
export const lineSheetPreviewBlob = async (sheet: unknown, existingId: string | null) => (await req(`${B}/preview`, { sheet, existing_id: existingId })).blob();
