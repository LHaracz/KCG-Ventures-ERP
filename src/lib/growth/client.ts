"use client";

/**
 * Browser calls to /api/growth (Marketing & Sales). Writes always go through
 * these server routes, which check access and validate.
 */
import { supabase } from "@/lib/supabaseClient";
import type { AssignableEmployee } from "./employees";
import type { LaunchDetail, LaunchListRow, MyTask } from "./launches";
import type { Lead, LeadActivity, LeadListRow, Trip, TripStop } from "./prospectingService";
import type { Asset, Claim, ClaimEvent, Post, Profile, RiskyWord, Template } from "./marketingService";

export class GrowthApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly fields: Record<string, string> | null,
  ) {
    super(message);
  }
}

export async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return { Authorization: `Bearer ${data.session?.access_token ?? ""}` };
}

export async function growthCall<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: { ...(await authHeader()), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> | null };
  if (!res.ok) throw new GrowthApiError(json.error || `Request failed (${res.status}).`, res.status, json.fields ?? null);
  return json as T;
}

const enc = encodeURIComponent;

export const fetchEmployees = () => growthCall<{ employees: AssignableEmployee[] }>("/api/growth/employees");

// Launch Pipeline
export type LaunchList = { rows: LaunchListRow[]; myTasks: MyTask[]; products: Array<{ id: string; name: string; in_development: boolean }>; today: string };
export const fetchLaunches = () => growthCall<LaunchList>("/api/growth/launches");
export const createLaunchApi = (body: Record<string, unknown>) => growthCall<{ launch: { id: string } }>("/api/growth/launches", body);
export const fetchLaunch = (id: string) => growthCall<LaunchDetail & { can_create_po: boolean }>(`/api/growth/launches/${enc(id)}`);
export const updateLaunchApi = (id: string, patch: Record<string, unknown>) => growthCall(`/api/growth/launches/${enc(id)}`, patch);
export const shiftLaunchApi = (id: string, body: Record<string, unknown>) => growthCall<{ moved: number }>(`/api/growth/launches/${enc(id)}/shift`, body);
export const syncLaunchApi = (id: string) => growthCall<{ added: number; removed: number }>(`/api/growth/launches/${enc(id)}/sync`, {});
export const addTaskApi = (id: string, body: Record<string, unknown>) => growthCall(`/api/growth/launches/${enc(id)}/tasks`, body);
export const updateTaskApi = (id: string, taskId: string, body: Record<string, unknown>) => growthCall(`/api/growth/launches/${enc(id)}/tasks/${enc(taskId)}`, body);
export const reorderTasksApi = (id: string, ids: string[]) => growthCall(`/api/growth/launches/${enc(id)}/tasks/reorder`, { ids });
export const ingredientApi = (id: string, rowId: string, body: Record<string, unknown>) => growthCall(`/api/growth/launches/${enc(id)}/ingredients/${enc(rowId)}`, body);
export type DueTask = { id: string; launch_id: string; launch_name: string; title: string; due_date: string; mine: boolean; overdue: boolean };
export const fetchTasksDue = () => growthCall<{ tasks: DueTask[] }>("/api/growth/launches/tasks-due");

// Retail Prospecting
export type ProspectingData = {
  today: string;
  leads: LeadListRow[];
  trips: Array<Trip & { stops: number }>;
  settings: { goal_retailers: number | null; goal_date: string | null };
  funnel: Record<string, number>;
  goal: { won: number; percent: number | null; daysRemaining: number | null; reached: boolean };
  followUps: string[];
  employees: AssignableEmployee[];
  is_admin: boolean;
};
const P = "/api/growth/prospecting";
export const fetchProspecting = () => growthCall<ProspectingData>(P);
export const saveGoalApi = (body: Record<string, unknown>) => growthCall(`${P}/settings`, body);
export const createLeadApi = (lead: Record<string, unknown>) => growthCall<{ lead: Lead }>(`${P}/leads`, { lead });
export const fetchLead = (id: string) =>
  growthCall<{ lead: Lead; activities: LeadActivity[]; trips: Trip[]; retailer: { id: string; name: string } | null; is_admin: boolean }>(`${P}/leads/${enc(id)}`);
export const updateLeadApi = (id: string, patch: Record<string, unknown>) => growthCall<{ lead: Lead }>(`${P}/leads/${enc(id)}`, patch);
export const logActivityApi = (id: string, activity: Record<string, unknown>, tripStopId?: string | null) =>
  growthCall(`${P}/leads/${enc(id)}/activities`, { activity, trip_stop_id: tripStopId ?? null });
export const voidActivityApi = (id: string, activityId: string) => growthCall(`${P}/leads/${enc(id)}/activities/${enc(activityId)}/void`, {});
export type ConvertResult = { retailer?: { id: string; name: string }; needs?: "confirm_not_won" | "confirm_duplicate"; existing?: { id: string; name: string } };
export const convertLeadApi = (id: string, body: Record<string, unknown>) => growthCall<ConvertResult>(`${P}/leads/${enc(id)}/convert`, body);
export const createTripApi = (body: Record<string, unknown>) => growthCall<{ trip: Trip }>(`${P}/trips`, body);
export const fetchTrip = (id: string) => growthCall<{ trip: Trip; stops: Array<TripStop & { lead: Lead }> }>(`${P}/trips/${enc(id)}`);
export const updateTripApi = (id: string, body: Record<string, unknown>) => growthCall(`${P}/trips/${enc(id)}`, body);
export const tripStopsApi = (id: string, body: Record<string, unknown>) => growthCall(`${P}/trips/${enc(id)}/stops`, body);
export type DueFollowUp = { id: string; name: string; city: string | null; next_follow_up_date: string; overdue: boolean };
export const fetchFollowUpsDue = () => growthCall<{ leads: DueFollowUp[] }>(`${P}/follow-ups`);

// Marketing Hub
export type MarketingData = {
  products: Array<{ id: string; name: string; in_development: boolean }>;
  profiles: Profile[];
  claims: Claim[];
  claimEvents: ClaimEvent[];
  assets: Asset[];
  posts: Post[];
  templates: Template[];
  riskyWords: RiskyWord[];
  employees: AssignableEmployee[];
  is_admin: boolean;
  me: string | null;
};
const M = "/api/growth/marketing";
export const fetchMarketing = () => growthCall<MarketingData>(M);
export const saveProfileApi = (productId: string, body: Record<string, unknown>) => growthCall(`${M}/profiles/${enc(productId)}`, body);
export const createClaimApi = (body: Record<string, unknown>) => growthCall<{ claim: Claim }>(`${M}/claims`, body);
export const updateClaimApi = (id: string, body: Record<string, unknown>) => growthCall<{ claim: Claim }>(`${M}/claims/${enc(id)}`, body);
export const submitClaimApi = (id: string) => growthCall(`${M}/claims/${enc(id)}/submit`, {});
export const reviewClaimApi = (id: string, body: Record<string, unknown>) => growthCall(`${M}/claims/${enc(id)}/review`, body);
export const createLinkAssetApi = (body: Record<string, unknown>) => growthCall<{ asset: Asset }>(`${M}/assets`, body);
export const assetUploadUrlApi = (body: Record<string, unknown>) => growthCall<{ path: string; token: string }>(`${M}/assets/upload-url`, body);
export const finalizeAssetApi = (body: Record<string, unknown>) => growthCall<{ asset: Asset }>(`${M}/assets/finalize`, body);
export const updateAssetApi = (id: string, body: Record<string, unknown>) => growthCall<{ asset: Asset }>(`${M}/assets/${enc(id)}`, body);
export const signedAssetUrlsApi = (ids: string[], download = false) => growthCall<{ urls: Record<string, string> }>(`${M}/assets/signed-urls`, { ids, download });
export const savePostApi = (id: string | null, body: Record<string, unknown>) => growthCall<{ id: string; warnings: string[] }>(id ? `${M}/posts/${enc(id)}` : `${M}/posts`, body);
export const archivePostApi = (id: string, archive: boolean) => growthCall(`${M}/posts/${enc(id)}`, archive ? { archive: true } : { restore: true });
export const saveTemplateApi = (id: string | null, body: Record<string, unknown>) => growthCall(id ? `${M}/templates/${enc(id)}` : `${M}/templates`, body);
export const saveRiskyWordApi = (id: string | null, body: Record<string, unknown>) => growthCall(id ? `${M}/risky-words/${enc(id)}` : `${M}/risky-words`, body);

/** Upload: signed URL from the server, straight to private storage, then the server checks the file. */
export async function uploadAsset(file: File, meta: Record<string, unknown>) {
  const { path, token } = await assetUploadUrlApi({ mime_type: file.type, size_bytes: file.size });
  const { error } = await supabase.storage.from("marketing-assets").uploadToSignedUrl(path, token, file, { contentType: file.type });
  if (error) throw new GrowthApiError(error.message || "The upload failed.", 500, null);
  return finalizeAssetApi({ ...meta, path, mime_type: file.type });
}
