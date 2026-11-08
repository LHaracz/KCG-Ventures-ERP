"use client";

import { supabase } from "@/lib/supabaseClient";

/** fetch() to this app's API with the signed-in user's token; throws the server's error message. */
export async function apiFetch<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${data.session?.access_token ?? ""}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body as { error?: string }).error || `Request failed (${res.status}).`) as Error & { code?: string; status?: number };
    err.code = (body as { code?: string }).code;
    err.status = res.status;
    throw err;
  }
  return body as T;
}
