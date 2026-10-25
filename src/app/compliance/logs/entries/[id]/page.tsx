"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { DocumentViewerModal, type DocumentViewerTarget } from "@/components/DocumentViewerModal";
import { formatDate } from "@/lib/date";
import { fetchActiveEmployees, type Employee } from "@/lib/employees";
import { DOCUMENT_TYPES, isLateEntry, type LogEntry, type LogEntryFile, type LogEntryReview, type LogType } from "@/lib/complianceLogs";

type PendingDocFile = {
  localId: string;
  file: File;
  documentType: LogEntryFile["document_type"];
  label: string;
};

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

export default function LogEntryDetailPage() {
  const params = useParams<{ id: string }>();
  const entryId = params.id;
  const { user, supabase } = useSupabase();

  const [entry, setEntry] = useState<LogEntry | null>(null);
  const [logType, setLogType] = useState<LogType | null>(null);
  const [originalEntry, setOriginalEntry] = useState<{ id: string; entry_number: number } | null>(null);
  const [correctingEntry, setCorrectingEntry] = useState<{ id: string; entry_number: number } | null>(null);
  const [files, setFiles] = useState<LogEntryFile[]>([]);
  const [reviews, setReviews] = useState<LogEntryReview[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [reviewEmployeeId, setReviewEmployeeId] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const [addDocsModalOpen, setAddDocsModalOpen] = useState(false);
  const [addDocsEmployeeId, setAddDocsEmployeeId] = useState("");
  const [pendingDocs, setPendingDocs] = useState<PendingDocFile[]>([]);
  const [addDocsSaving, setAddDocsSaving] = useState(false);
  const [addDocsProgress, setAddDocsProgress] = useState<string | null>(null);
  const [addDocsError, setAddDocsError] = useState<string | null>(null);

  const [viewerTarget, setViewerTarget] = useState<DocumentViewerTarget | null>(null);

  const getToken = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Unable to verify your session.");
    return token;
  };

  const load = async () => {
    if (!entryId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const { data: entryRow, error: entryError } = await supabase
        .from("log_entries")
        .select("*")
        .eq("id", entryId)
        .maybeSingle();
      if (entryError) throw new Error(entryError.message);
      if (!entryRow) throw new Error("Entry not found.");
      setEntry(entryRow as LogEntry);

      const [typeResult, filesResult, reviewsResult, correctorResult, employeesResult] = await Promise.all([
        supabase.from("log_types").select("*").eq("id", entryRow.log_type_id).maybeSingle(),
        supabase.from("log_entry_files").select("*").eq("log_entry_id", entryId).order("added_at"),
        supabase.from("log_entry_reviews").select("*").eq("log_entry_id", entryId).order("reviewed_at", { ascending: false }),
        supabase.from("log_entries").select("id, entry_number").eq("corrects_entry_id", entryId).maybeSingle(),
        fetchActiveEmployees(supabase),
      ]);
      if (typeResult.error) throw new Error(typeResult.error.message);
      setLogType(typeResult.data as LogType);
      setFiles((filesResult.data ?? []) as LogEntryFile[]);
      setReviews((reviewsResult.data ?? []) as LogEntryReview[]);
      setCorrectingEntry((correctorResult.data as any) ?? null);
      setEmployees(employeesResult);

      if (entryRow.corrects_entry_id) {
        const { data: original } = await supabase
          .from("log_entries")
          .select("id, entry_number")
          .eq("id", entryRow.corrects_entry_id)
          .maybeSingle();
        setOriginalEntry(original as any);
      }
    } catch (err: any) {
      setLoadError(err.message || "Failed to load this entry.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, entryId]);

  const late = entry ? isLateEntry(entry.performed_at, entry.created_at) : false;

  const handleMarkReviewed = async () => {
    if (!entry) return;
    if (!reviewEmployeeId) {
      setReviewError("Choose who reviewed this entry.");
      return;
    }
    const employee = employees.find((e) => e.id === reviewEmployeeId);
    if (!employee) {
      setReviewError("Selected employee not found.");
      return;
    }
    setReviewSaving(true);
    setReviewError(null);
    try {
      const { error } = await supabase.from("log_entry_reviews").insert({
        log_entry_id: entry.id,
        reviewed_by_employee_id: employee.id,
        reviewed_by_name: employee.full_name,
        note: reviewNote.trim() || null,
      });
      if (error) throw new Error(error.message);
      setReviewModalOpen(false);
      setReviewEmployeeId("");
      setReviewNote("");
      await load();
    } catch (err: any) {
      setReviewError(err.message || "Failed to save this review.");
    } finally {
      setReviewSaving(false);
    }
  };

  const fileLabel = (file: LogEntryFile) => {
    const typeLabel = DOCUMENT_TYPES.find((t) => t.value === file.document_type)?.label ?? file.document_type;
    return file.label ? `${typeLabel} — ${file.label}` : `${typeLabel} — ${file.original_filename}`;
  };

  const openFileViewer = (file: LogEntryFile) => {
    setViewerTarget({
      fileName: file.original_filename,
      title: fileLabel(file),
      fetchSignedUrl: async (opts) => {
        const token = await getToken();
        const url = `/api/compliance/logs/entries/${entryId}/documents/${file.id}/signed-url${opts?.download ? "?download=1" : ""}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || "Failed to load this file.");
        return payload.url as string;
      },
    });
  };

  const handleAddDocsFilesSelected = (fileList: FileList | null) => {
    if (!fileList) return;
    const additions: PendingDocFile[] = Array.from(fileList).map((file) => ({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      documentType: "other",
      label: "",
    }));
    setPendingDocs((prev) => [...prev, ...additions]);
  };

  const handleSubmitAddDocs = async () => {
    if (!entry) return;
    setAddDocsError(null);
    if (!addDocsEmployeeId) {
      setAddDocsError("Choose who is adding these documents.");
      return;
    }
    const employee = employees.find((e) => e.id === addDocsEmployeeId);
    if (!employee) {
      setAddDocsError("Selected employee not found.");
      return;
    }
    if (pendingDocs.length === 0) {
      setAddDocsError("Choose at least one file.");
      return;
    }
    setAddDocsSaving(true);
    try {
      const token = await getToken();
      const uploaded: Array<{ path: string; originalFilename: string; documentType: string; label: string | null }> = [];
      for (let i = 0; i < pendingDocs.length; i++) {
        const pf = pendingDocs[i];
        setAddDocsProgress(`Uploading ${i + 1} of ${pendingDocs.length}…`);
        const uploadUrlRes = await fetch("/api/compliance/logs/documents/upload-url", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: pf.file.name, fileSize: pf.file.size, mimeType: pf.file.type, logEntryId: entry.id }),
        });
        const uploadUrlPayload = await uploadUrlRes.json();
        if (!uploadUrlRes.ok) throw new Error(`"${pf.file.name}": ${uploadUrlPayload.error || "upload failed"}`);
        const { path, token: uploadToken } = uploadUrlPayload as { path: string; token: string };

        const { error: uploadError } = await supabase.storage.from("log-entry-docs").uploadToSignedUrl(path, uploadToken, pf.file);
        if (uploadError) throw new Error(`"${pf.file.name}": ${uploadError.message}`);

        uploaded.push({ path, originalFilename: pf.file.name, documentType: pf.documentType, label: pf.label.trim() || null });
      }

      setAddDocsProgress("Saving…");
      const res = await fetch(`/api/compliance/logs/entries/${entry.id}/documents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ addedByName: employee.full_name, files: uploaded }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Failed to add these documents.");

      setAddDocsModalOpen(false);
      setAddDocsEmployeeId("");
      setPendingDocs([]);
      await load();
    } catch (err: any) {
      setAddDocsError(err.message || "Failed to add these documents.");
    } finally {
      setAddDocsSaving(false);
      setAddDocsProgress(null);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-3xl space-y-4">
        <Link
          href={logType ? `/compliance/logs/${logType.slug}` : "/compliance/logs"}
          className="inline-block text-[11px] font-medium text-emerald-700 underline"
        >
          ← Back to {logType?.name ?? "log"}
        </Link>

        {loading ? (
          <p className="text-xs text-black">Loading…</p>
        ) : loadError ? (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        ) : entry && logType ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h1 className="text-2xl font-semibold text-zinc-900">
                  {logType.name} — Entry #{entry.entry_number}
                </h1>
                <p className="text-sm text-black">
                  Performed {formatDate(entry.performed_at)} by {entry.performed_by_name}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAddDocsModalOpen(true)}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                >
                  Add Documents
                </button>
                <button
                  type="button"
                  onClick={() => setReviewModalOpen(true)}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                >
                  Mark Reviewed
                </button>
                <Link
                  href={`/compliance/logs/${logType.slug}/new?correctsEntryId=${entry.id}`}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
                >
                  Correct This Entry
                </Link>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {entry.is_out_of_spec && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
                  Out of spec
                </span>
              )}
              {late && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                  Late entry
                </span>
              )}
              {correctingEntry && (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
                  Corrected by{" "}
                  <Link href={`/compliance/logs/entries/${correctingEntry.id}`} className="underline">
                    #{correctingEntry.entry_number}
                  </Link>
                </span>
              )}
            </div>

            {entry.corrects_entry_id && originalEntry && (
              <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
                This entry corrects{" "}
                <Link href={`/compliance/logs/entries/${originalEntry.id}`} className="font-medium text-emerald-700 underline">
                  Entry #{originalEntry.entry_number}
                </Link>
                {entry.correction_reason && <> — {entry.correction_reason}</>}
              </div>
            )}

            {entry.is_out_of_spec && (
              <div className="rounded-md border border-red-300 bg-red-50 p-3">
                <p className="text-sm font-semibold text-red-800">Out of spec</p>
                <ul className="mt-1 list-inside list-disc text-xs text-red-700">
                  {(entry.out_of_spec_details ?? []).map((d) => (
                    <li key={d.key}>
                      {d.label}: {String(d.value)}
                      {d.reason === "below_min" && d.limit != null && ` (below minimum ${d.limit})`}
                      {d.reason === "above_max" && d.limit != null && ` (above maximum ${d.limit})`}
                      {d.reason === "fail" && " (marked Fail)"}
                    </li>
                  ))}
                </ul>
                {entry.corrective_action && (
                  <p className="mt-2 text-xs text-red-900">
                    <span className="font-medium">Corrective action:</span> {entry.corrective_action}
                  </p>
                )}
              </div>
            )}

            <section className="rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">Recorded values</h2>
              <dl className="divide-y divide-zinc-100 text-xs">
                {(entry.template_snapshot?.fields ?? []).map((field) => {
                  const value = entry.values?.[field.key];
                  const display =
                    value === undefined || value === null || value === ""
                      ? "—"
                      : Array.isArray(value)
                        ? value.join(", ")
                        : String(value);
                  return (
                    <div key={field.key} className="flex justify-between gap-4 py-1.5">
                      <dt className="text-zinc-500">
                        {field.label}
                        {field.unit ? ` (${field.unit})` : ""}
                      </dt>
                      <dd className="text-right text-zinc-900">{display}</dd>
                    </div>
                  );
                })}
              </dl>
            </section>

            <section className="rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">Documents</h2>
              {files.length === 0 ? (
                <p className="text-xs text-black">No documents attached.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {files.map((file) => (
                    <li key={file.id}>
                      <button type="button" onClick={() => openFileViewer(file)} className="text-emerald-700 underline">
                        {fileLabel(file)}
                      </button>
                      {file.added_after_submit && <span className="text-zinc-500"> (added later)</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-semibold text-zinc-900">Reviews</h2>
              {reviews.length === 0 ? (
                <p className="text-xs text-black">Not yet reviewed.</p>
              ) : (
                <ul className="space-y-1.5 text-xs text-zinc-700">
                  {reviews.map((review) => (
                    <li key={review.id}>
                      {review.reviewed_by_name} — {formatDate(review.reviewed_at)}
                      {review.note && <span className="text-zinc-500"> — {review.note}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}

        {reviewModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">Mark Reviewed</h2>
              <p className="mt-1 text-xs text-zinc-600">
                A simple sign-off from the roster — this will become real verification once user
                accounts exist.
              </p>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Reviewed by</label>
                  <select
                    value={reviewEmployeeId}
                    onChange={(e) => setReviewEmployeeId(e.target.value)}
                    className={inputClassName}
                  >
                    <option value="">Select…</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.full_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Note (optional)</label>
                  <textarea
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                    rows={2}
                    className={inputClassName}
                  />
                </div>
                {reviewError && (
                  <p className="text-xs text-red-600" role="alert">
                    {reviewError}
                  </p>
                )}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReviewModalOpen(false)}
                  disabled={reviewSaving}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleMarkReviewed}
                  disabled={reviewSaving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {reviewSaving ? "Saving…" : "Save Review"}
                </button>
              </div>
            </div>
          </div>
        )}

        {addDocsModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">Add Documents</h2>
              <p className="mt-1 text-xs text-zinc-600">
                This is the only change allowed on a submitted entry — it never alters the
                entry&rsquo;s recorded values.
              </p>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Added by</label>
                  <select
                    value={addDocsEmployeeId}
                    onChange={(e) => setAddDocsEmployeeId(e.target.value)}
                    className={inputClassName}
                  >
                    <option value="">Select…</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.full_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">Files</label>
                  <input
                    type="file"
                    multiple
                    accept="application/pdf,image/png,image/jpeg"
                    onChange={(e) => {
                      handleAddDocsFilesSelected(e.target.files);
                      e.target.value = "";
                    }}
                    className="block w-full text-xs text-black"
                  />
                </div>
                {pendingDocs.length > 0 && (
                  <div className="space-y-2">
                    {pendingDocs.map((pf) => (
                      <div key={pf.localId} className="grid gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 sm:grid-cols-[1fr_auto]">
                        <p className="truncate text-[11px] text-zinc-700" title={pf.file.name}>
                          {pf.file.name}
                        </p>
                        <select
                          value={pf.documentType}
                          onChange={(e) =>
                            setPendingDocs((prev) =>
                              prev.map((f) =>
                                f.localId === pf.localId
                                  ? { ...f, documentType: e.target.value as LogEntryFile["document_type"] }
                                  : f,
                              ),
                            )
                          }
                          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] text-black shadow-sm"
                        >
                          {DOCUMENT_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
                {addDocsError && (
                  <p className="text-xs text-red-600" role="alert">
                    {addDocsError}
                  </p>
                )}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAddDocsModalOpen(false);
                    setPendingDocs([]);
                    setAddDocsError(null);
                  }}
                  disabled={addDocsSaving}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSubmitAddDocs}
                  disabled={addDocsSaving}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {addDocsSaving ? addDocsProgress || "Saving…" : "Add Documents"}
                </button>
              </div>
            </div>
          </div>
        )}

        {viewerTarget && <DocumentViewerModal target={viewerTarget} onClose={() => setViewerTarget(null)} />}
      </div>
    </AuthGuard>
  );
}
