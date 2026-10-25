"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";

const inputClassName =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black placeholder:text-zinc-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

type SopRow = {
  id: string;
  title: string;
  sop_number: string | null;
  description: string | null;
  archived_at: string | null;
  created_at: string;
};

type CurrentVersionRow = {
  id: string;
  sop_id: string;
  version_number: number;
  effective_date: string | null;
  uploaded_at: string;
};

type UploadModalState =
  | { mode: "new" }
  | { mode: "new-version"; sopId: string; sopTitle: string };

function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}

function validatePdfFile(file: File): string | null {
  const nameOk = file.name.toLowerCase().endsWith(".pdf");
  const typeOk = file.type === "application/pdf";
  if (!nameOk || !typeOk) return "Only PDF files are supported.";
  if (file.size > MAX_FILE_BYTES) return "File exceeds the 25 MB limit.";
  if (file.size === 0) return "This file is empty.";
  return null;
}

export default function SopLibraryPage() {
  const { user, supabase } = useSupabase();

  const [sops, setSops] = useState<SopRow[]>([]);
  const [currentVersions, setCurrentVersions] = useState<Map<string, CurrentVersionRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const [actionsFor, setActionsFor] = useState<SopRow | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<SopRow | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [uploadModal, setUploadModal] = useState<UploadModalState | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [sopsResult, versionsResult] = await Promise.all([
        supabase.from("sops").select("id, title, sop_number, description, archived_at, created_at"),
        supabase
          .from("sop_versions")
          .select("id, sop_id, version_number, effective_date, uploaded_at")
          .eq("is_current", true),
      ]);
      if (sopsResult.error) throw new Error(sopsResult.error.message);
      if (versionsResult.error) throw new Error(versionsResult.error.message);
      setSops((sopsResult.data ?? []) as SopRow[]);
      const map = new Map<string, CurrentVersionRow>();
      for (const v of (versionsResult.data ?? []) as CurrentVersionRow[]) {
        map.set(v.sop_id, v);
      }
      setCurrentVersions(map);
    } catch (err: any) {
      setLoadError(err.message || "Failed to load the SOP library.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const visibleSops = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sops
      .filter((s) => (showArchived ? true : !s.archived_at))
      .filter((s) => {
        if (!term) return true;
        return (
          s.title.toLowerCase().includes(term) ||
          (s.sop_number ?? "").toLowerCase().includes(term)
        );
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [sops, search, showArchived]);

  const handleArchive = async () => {
    if (!archiveConfirm) return;
    setArchiving(true);
    try {
      const { error } = await supabase
        .from("sops")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", archiveConfirm.id);
      if (error) throw new Error(error.message);
      setArchiveConfirm(null);
      await load();
    } catch (err: any) {
      // Keep the confirm modal open with inline feedback rather than losing
      // the user's place.
      setLoadError(err.message || "Failed to archive this SOP.");
    } finally {
      setArchiving(false);
    }
  };

  const handleRestore = async (sop: SopRow) => {
    setRestoringId(sop.id);
    try {
      const { error } = await supabase.from("sops").update({ archived_at: null }).eq("id", sop.id);
      if (error) throw new Error(error.message);
      await load();
    } catch (err: any) {
      setLoadError(err.message || "Failed to restore this SOP.");
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">SOP Library</h1>
            <p className="text-sm text-black">
              Standard operating procedures — upload, view, and track versions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setUploadModal({ mode: "new" })}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
          >
            Upload SOP
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or SOP #…"
            className={`${inputClassName} max-w-xs`}
          />
          <label className="flex items-center gap-1.5 text-xs text-black">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show archived
          </label>
        </div>

        {loadError && (
          <p className="text-xs text-red-600" role="alert">
            {loadError}
          </p>
        )}

        <section className="rounded-md border border-zinc-200 bg-white p-4">
          {loading ? (
            <p className="text-xs text-black">Loading…</p>
          ) : visibleSops.length === 0 ? (
            <p className="text-xs text-black">
              {sops.length === 0 ? "No SOPs uploaded yet." : "No SOPs match your filters."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">SOP #</th>
                    <th className="px-3 py-2 font-medium">Current Version</th>
                    <th className="px-3 py-2 font-medium">Effective Date</th>
                    <th className="px-3 py-2 font-medium">Last Updated</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSops.map((sop) => {
                    const current = currentVersions.get(sop.id);
                    return (
                      <tr key={sop.id} className="border-b border-zinc-100">
                        <td className="px-3 py-2 text-zinc-900">
                          {sop.title}
                          {sop.archived_at && (
                            <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600">
                              Archived
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-zinc-700">{sop.sop_number || "—"}</td>
                        <td className="px-3 py-2 text-zinc-700">
                          {current ? `v${current.version_number}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-zinc-700">
                          {current?.effective_date ? formatDate(current.effective_date) : "—"}
                        </td>
                        <td className="px-3 py-2 text-zinc-700">
                          {current ? formatDate(current.uploaded_at) : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/compliance/sops/${sop.id}`}
                              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                            >
                              View
                            </Link>
                            {sop.archived_at ? (
                              <button
                                type="button"
                                disabled={restoringId === sop.id}
                                onClick={() => handleRestore(sop)}
                                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {restoringId === sop.id ? "Restoring…" : "Restore"}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setActionsFor(sop)}
                                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                              >
                                Actions
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {actionsFor && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setActionsFor(null)}
          >
            <div
              className="w-full max-w-xs rounded-md border border-zinc-200 bg-white p-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className="truncate text-sm font-semibold text-black">{actionsFor.title}</h2>
                <button
                  type="button"
                  onClick={() => setActionsFor(null)}
                  aria-label="Close"
                  className="text-zinc-500 hover:text-zinc-700"
                >
                  ✕
                </button>
              </div>
              <div className="space-y-1">
                <Link
                  href={`/compliance/sops/${actionsFor.id}`}
                  onClick={() => setActionsFor(null)}
                  className="block rounded-md px-3 py-2 text-sm font-medium text-black hover:bg-zinc-50"
                >
                  View
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setUploadModal({ mode: "new-version", sopId: actionsFor.id, sopTitle: actionsFor.title });
                    setActionsFor(null);
                  }}
                  className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-black hover:bg-zinc-50"
                >
                  Upload New Version
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setArchiveConfirm(actionsFor);
                    setActionsFor(null);
                  }}
                  className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-black hover:bg-zinc-50"
                >
                  Archive
                </button>
              </div>
            </div>
          </div>
        )}

        {archiveConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-900">Archive this SOP?</h2>
              <p className="mt-1 text-xs text-zinc-600">
                &ldquo;{archiveConfirm.title}&rdquo; will be hidden from the library by default. It
                isn&apos;t deleted — compliance documents are retained — and you can restore it
                anytime with &ldquo;Show archived&rdquo;.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setArchiveConfirm(null)}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleArchive}
                  disabled={archiving}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {archiving ? "Archiving…" : "Archive"}
                </button>
              </div>
            </div>
          </div>
        )}

        {uploadModal && (
          <UploadSopModal
            state={uploadModal}
            onClose={() => setUploadModal(null)}
            onUploaded={async () => {
              setUploadModal(null);
              await load();
            }}
          />
        )}
      </div>
    </AuthGuard>
  );
}

function UploadSopModal({
  state,
  onClose,
  onUploaded,
}: {
  state: UploadModalState;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const { supabase } = useSupabase();

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [sopNumber, setSopNumber] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [description, setDescription] = useState("");
  const [changeNote, setChangeNote] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isNewVersion = state.mode === "new-version";

  const handleFileChange = (selected: File | null) => {
    setFile(selected);
    setFileError(null);
    if (!selected) return;
    const validationError = validatePdfFile(selected);
    if (validationError) {
      setFileError(validationError);
      return;
    }
    if (!isNewVersion && !title.trim()) {
      setTitle(stripExtension(selected.name));
    }
  };

  const getToken = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Unable to verify your session.");
    return token;
  };

  const handleSubmit = async () => {
    if (!file) {
      setFileError("Choose a PDF file.");
      return;
    }
    const validationError = validatePdfFile(file);
    if (validationError) {
      setFileError(validationError);
      return;
    }
    if (!isNewVersion && !title.trim()) {
      setSubmitError("Name is required.");
      return;
    }
    if (isNewVersion && !changeNote.trim()) {
      setSubmitError('"What changed?" is required.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const token = await getToken();

      setProgress("Requesting upload URL…");
      const uploadUrlRes = await fetch("/api/compliance/sops/upload-url", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          sopId: isNewVersion ? state.sopId : undefined,
        }),
      });
      const uploadUrlPayload = await uploadUrlRes.json();
      if (!uploadUrlRes.ok) throw new Error(uploadUrlPayload.error || "Failed to prepare the upload.");
      const { path, token: uploadToken } = uploadUrlPayload as { path: string; token: string };

      setProgress("Uploading file…");
      const { error: uploadError } = await supabase.storage
        .from("sops")
        .uploadToSignedUrl(path, uploadToken, file);
      if (uploadError) throw new Error(uploadError.message || "Failed to upload the file.");

      setProgress("Saving…");
      if (isNewVersion) {
        const res = await fetch(`/api/compliance/sops/${state.sopId}/versions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            path,
            originalFilename: file.name,
            changeNote: changeNote.trim(),
            effectiveDate: effectiveDate || null,
          }),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || "Failed to save the new version.");
      } else {
        const res = await fetch("/api/compliance/sops", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            path,
            originalFilename: file.name,
            title: title.trim(),
            sopNumber: sopNumber.trim() || null,
            description: description.trim() || null,
            effectiveDate: effectiveDate || null,
          }),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || "Failed to save the SOP.");
      }

      onUploaded();
    } catch (err: any) {
      setSubmitError(err.message || "Upload failed.");
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-md border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">
          {isNewVersion ? `Upload New Version — ${state.sopTitle}` : "Upload SOP"}
        </h2>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-800">PDF file</label>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-black"
            />
            {fileError && (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {fileError}
              </p>
            )}
          </div>

          {!isNewVersion && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-800">Name</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="SOP name"
                  className={inputClassName}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">
                    SOP number (optional)
                  </label>
                  <input
                    value={sopNumber}
                    onChange={(e) => setSopNumber(e.target.value)}
                    placeholder="SOP-001"
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-800">
                    Effective date (optional)
                  </label>
                  <input
                    type="date"
                    value={effectiveDate}
                    onChange={(e) => setEffectiveDate(e.target.value)}
                    className={inputClassName}
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-800">
                  Description (optional)
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className={inputClassName}
                />
              </div>
            </>
          )}

          {isNewVersion && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-800">
                  Effective date (optional)
                </label>
                <input
                  type="date"
                  value={effectiveDate}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                  className={inputClassName}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-800">
                  What changed?
                </label>
                <textarea
                  value={changeNote}
                  onChange={(e) => setChangeNote(e.target.value)}
                  rows={3}
                  placeholder="Summarize what's different in this version"
                  className={inputClassName}
                />
              </div>
            </>
          )}

          {progress && <p className="text-xs text-zinc-600">{progress}</p>}
          {submitError && (
            <p className="text-xs text-red-600" role="alert">
              {submitError}
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? progress || "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
