"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { Editor } from "@tiptap/react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { SopEditor } from "@/components/sop/SopEditor";
import { SopRenderProvider, useSopRender } from "@/components/sop/SopRenderContext";
import { blankDocument, findFormulaTables, type DocNode } from "@/lib/sopDocument";
import { listBotaniqalsProducts, type BotanicalProduct } from "@/lib/sopFormulaData";
import { YouName } from "@/components/access/People";
import { MAX_SOP_IMAGE_BYTES, isAllowedImageMime } from "@/lib/sopImageStorage";

type SopInfo = {
  id: string;
  title: string;
  sop_number: string | null;
  description: string | null;
  format: "pdf" | "document";
  product_id: string | null;
  archived_at: string | null;
};

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";

const input =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

function todayNY(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function timeNY(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

export default function SopEditPage() {
  const params = useParams<{ id: string }>();
  const sopId = params.id;
  const router = useRouter();
  const { user, supabase } = useSupabase();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sop, setSop] = useState<SopInfo | null>(null);
  const [initial, setInitial] = useState<DocNode | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [products, setProducts] = useState<BotanicalProduct[]>([]);
  const [hasDraft, setHasDraft] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<{ id: string; version_number: number } | null>(null);

  const revisionRef = useRef(0);
  const baseVersionIdRef = useRef<string | null>(null);
  const latestDoc = useRef<DocNode | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ revision: number } | null>(null);

  const [discardOpen, setDiscardOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  const getToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Unable to verify your session.");
    return token;
  }, [supabase]);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const token = await getToken();
      const res = await fetch(path, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
      const payload = await res.json().catch(() => ({}));
      return { res, payload };
    },
    [getToken],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [{ res, payload }, productList] = await Promise.all([api(`/api/compliance/sops/${sopId}/draft`), listBotaniqalsProducts(supabase)]);
      if (!res.ok) throw new Error(payload.error || "Failed to load this SOP.");
      setSop(payload.sop as SopInfo);
      setProducts(productList);
      setCurrentVersion(payload.currentVersion ? { id: payload.currentVersion.id, version_number: payload.currentVersion.version_number } : null);
      revisionRef.current = payload.revision ?? 0;
      setHasDraft(!!payload.draft);
      baseVersionIdRef.current = payload.draft ? payload.draftBaseVersionId ?? null : payload.currentVersion?.id ?? null;
      const start: DocNode = payload.draft ?? payload.currentVersion?.content ?? blankDocument();
      latestDoc.current = start;
      dirtyRef.current = false;
      setInitial(start);
      setEditorKey((k) => k + 1);
      setSaveState(payload.draft ? "saved" : "idle");
      setSavedAt(payload.draftUpdatedAt ?? null);
    } catch (err: any) {
      setLoadError(err.message || "Failed to load this SOP.");
    } finally {
      setLoading(false);
    }
  }, [api, sopId, supabase]);

  useEffect(() => {
    if (user && sopId) load();
  }, [user, sopId, load]);

  /** Saves the latest document if it changed. Resolves true when everything is saved. */
  const save = useCallback(
    async (opts?: { overrideRevision?: number }): Promise<boolean> => {
      if (savingRef.current) {
        await savingRef.current;
        if (!dirtyRef.current) return true;
      }
      if (!dirtyRef.current && opts?.overrideRevision === undefined) return true;
      const doc = latestDoc.current;
      if (!doc) return true;
      const run = (async () => {
        dirtyRef.current = false;
        setSaveState("saving");
        setSaveError(null);
        try {
          const expected = opts?.overrideRevision ?? revisionRef.current;
          const { res, payload } = await api(`/api/compliance/sops/${sopId}/draft`, {
            method: "PUT",
            body: JSON.stringify({ content: doc, expectedRevision: expected, baseVersionId: baseVersionIdRef.current }),
          });
          if (res.status === 409) {
            dirtyRef.current = true;
            setConflict({ revision: payload.revision });
            setSaveState("conflict");
            return false;
          }
          if (!res.ok) {
            dirtyRef.current = true;
            setSaveError(payload.error || "Save failed.");
            setSaveState("error");
            return false;
          }
          revisionRef.current = payload.revision;
          setHasDraft(true);
          setSavedAt(payload.savedAt);
          setSaveState(dirtyRef.current ? "dirty" : "saved");
          return !dirtyRef.current;
        } catch (err: any) {
          dirtyRef.current = true;
          setSaveError(err.message || "Save failed.");
          setSaveState("error");
          return false;
        }
      })();
      savingRef.current = run;
      const ok = await run;
      savingRef.current = null;
      if (ok && dirtyRef.current) return save();
      return ok;
    },
    [api, sopId],
  );

  const onChange = useCallback(
    (doc: DocNode) => {
      latestDoc.current = doc;
      dirtyRef.current = true;
      setSaveState((s) => (s === "conflict" ? s : "dirty"));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (!conflict) save();
      }, 2000);
    },
    [save, conflict],
  );

  const onBlur = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (dirtyRef.current && !conflict) save();
  }, [save, conflict]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  const uploadImage = useCallback(
    async (file: File): Promise<{ path: string } | null> => {
      if (!isAllowedImageMime(file.type)) {
        setSaveError("Images must be PNG, JPG or WebP.");
        return null;
      }
      if (file.size > MAX_SOP_IMAGE_BYTES) {
        setSaveError("Images must be 10 MB or smaller.");
        return null;
      }
      try {
        const { res, payload } = await api(`/api/compliance/sops/${sopId}/images/upload-url`, {
          method: "POST",
          body: JSON.stringify({ mimeType: file.type, fileSize: file.size }),
        });
        if (!res.ok) throw new Error(payload.error || "Image upload failed.");
        const { error: upErr } = await supabase.storage.from("sop-images").uploadToSignedUrl(payload.path, payload.token, file, { contentType: file.type });
        if (upErr) throw new Error(upErr.message);
        const done = await api(`/api/compliance/sops/${sopId}/images`, {
          method: "POST",
          body: JSON.stringify({ path: payload.path, originalFilename: file.name }),
        });
        if (!done.res.ok) throw new Error(done.payload.error || "Image upload failed.");
        return { path: payload.path };
      } catch (err: any) {
        setSaveError(err.message || "Image upload failed.");
        return null;
      }
    },
    [api, sopId, supabase],
  );

  const handleDiscard = async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (savingRef.current) await savingRef.current;
    const { res, payload } = await api(`/api/compliance/sops/${sopId}/draft?expectedRevision=${revisionRef.current}`, { method: "DELETE" });
    if (res.status === 409) {
      setDiscardOpen(false);
      setConflict({ revision: -1 });
      setSaveState("conflict");
      return;
    }
    if (!res.ok) {
      setSaveError(payload.error || "Failed to discard the draft.");
      return;
    }
    dirtyRef.current = false;
    setDiscardOpen(false);
    await load();
  };

  const statusText =
    saveState === "saving"
      ? "Saving…"
      : saveState === "saved"
        ? `Saved${savedAt ? ` ${timeNY(savedAt)}` : ""}`
        : saveState === "dirty"
          ? "Unsaved changes"
          : saveState === "error"
            ? "Not saved"
            : saveState === "conflict"
              ? "Conflict"
              : hasDraft
                ? "Draft"
                : "No changes yet";

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-3 text-black">
        <Link href={`/compliance/sops/${sopId}`} className="inline-block text-[11px] font-medium text-emerald-800 underline">
          ← Back to SOP
        </Link>
        {loading && !sop ? (
          <p className="text-xs text-black">Loading…</p>
        ) : loadError ? (
          <p className="text-xs text-red-600" role="alert">{loadError}</p>
        ) : sop && initial ? (
          <SopRenderProvider mode="live" products={products} defaultProductId={sop.product_id} supabase={supabase} getToken={getToken}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h1 className="text-xl font-semibold text-black">Edit: {sop.title}</h1>
                <p className="text-xs text-black">
                  {sop.sop_number ? `${sop.sop_number} · ` : ""}
                  {currentVersion ? `Editing a draft based on v${currentVersion.version_number}. The published version is not affected until you publish.` : "Not published yet."}
                </p>
                {sop.format === "pdf" && (
                  <p className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-black">
                    This SOP is currently a PDF. Publishing here creates its first editable version. The PDF versions stay in the history.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-black" aria-live="polite">{statusText}</span>
                <button
                  type="button"
                  onClick={() => setDiscardOpen(true)}
                  disabled={!hasDraft && !dirtyRef.current}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-zinc-50 disabled:opacity-50"
                >
                  Discard draft
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (timerRef.current) clearTimeout(timerRef.current);
                    const ok = await save();
                    if (ok && (hasDraft || revisionRef.current > 0)) setPublishOpen(true);
                    else if (ok) setSaveError("Make a change before publishing.");
                  }}
                  disabled={saveState === "conflict"}
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  Publish…
                </button>
              </div>
            </div>
            {saveError && <p className="text-xs text-red-600" role="alert">{saveError}</p>}

            <SopEditor key={editorKey} initialContent={initial} onChange={onChange} onBlur={onBlur} onUploadImage={uploadImage} editorRef={editorRef} />

            {conflict && (
              <Modal title="This SOP was changed in another session">
                <p className="text-xs text-black">
                  Someone saved this draft from another tab or device after you started editing. Reload to see their version, or keep yours and replace it.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-zinc-50"
                    onClick={async () => {
                      setConflict(null);
                      dirtyRef.current = false;
                      await load();
                    }}
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
                    onClick={async () => {
                      let rev = conflict.revision;
                      if (rev < 0) {
                        const { payload } = await api(`/api/compliance/sops/${sopId}/draft`);
                        rev = payload.revision ?? 0;
                      }
                      setConflict(null);
                      dirtyRef.current = true;
                      await save({ overrideRevision: rev });
                    }}
                  >
                    Keep mine
                  </button>
                </div>
              </Modal>
            )}

            {discardOpen && (
              <Modal title="Discard this draft?">
                <p className="text-xs text-black">All unpublished changes will be thrown away. The published version stays exactly as it is.</p>
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black" onClick={() => setDiscardOpen(false)}>
                    Cancel
                  </button>
                  <button type="button" className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700" onClick={handleDiscard}>
                    Discard draft
                  </button>
                </div>
              </Modal>
            )}

            {publishOpen && (
              <PublishDialog
                doc={latestDoc.current ?? initial}
                onCancel={() => setPublishOpen(false)}
                supabase={supabase}
                onPublish={async (form) => {
                  const { res, payload } = await api(`/api/compliance/sops/${sopId}/publish`, {
                    method: "POST",
                    body: JSON.stringify({ ...form, expectedRevision: revisionRef.current }),
                  });
                  if (res.status === 409) {
                    setPublishOpen(false);
                    setConflict({ revision: -1 });
                    setSaveState("conflict");
                    return null;
                  }
                  if (!res.ok) return payload.error || "Publish failed.";
                  dirtyRef.current = false;
                  router.push(`/compliance/sops/${sopId}`);
                  return null;
                }}
              />
            )}
          </SopRenderProvider>
        ) : null}
      </div>
    </AuthGuard>
  );
}

function Modal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-md border border-zinc-200 bg-white p-4 text-black">
        <h2 className="mb-2 text-sm font-semibold text-black">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function PublishDialog({
  doc,
  onCancel,
  onPublish,
  supabase,
}: {
  doc: DocNode;
  onCancel: () => void;
  onPublish: (form: { changeNote: string; effectiveDate: string }) => Promise<string | null>;
  supabase: any;
}) {
  const ctx = useSopRender();
  const [changeNote, setChangeNote] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayNY());

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tables = findFormulaTables(doc);

  useEffect(() => {
    tables.forEach((t) => t.productId && ctx.requestLive(t.productId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (!changeNote.trim()) return setError("Describe what changed.");
    if (!effectiveDate) return setError("Choose an effective date.");
    setBusy(true);
    setError(null);
    const err = await onPublish({ changeNote: changeNote.trim(), effectiveDate, });
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <Modal title="Publish a new version">
      <div className="space-y-3 text-xs text-black">
        <div>
          <label className="mb-1 block font-medium">What changed? (required)</label>
          <textarea value={changeNote} onChange={(e) => setChangeNote(e.target.value)} rows={3} className={input} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block font-medium">Effective date</label>
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={input} />
          </div>
          <YouName label="Published by" />
        </div>
        <div>
          <p className="mb-1 font-medium">Formula tables ({tables.length})</p>
          {tables.length === 0 ? (
            <p>None in this document.</p>
          ) : (
            <ul className="space-y-1">
              {tables.map((t, i) => {
                const product = t.productId ? ctx.products.find((p) => p.id === t.productId) : null;
                const live = t.productId ? ctx.getLive(t.productId) : null;
                const d = live?.data;
                let line: string;
                let warn = false;
                if (!t.productId) {
                  line = "No product selected";
                  warn = true;
                } else if (!live || (live.loading && !d)) line = `${product?.name ?? "Product"}: loading…`;
                else if (live.error) {
                  line = `${product?.name ?? "Product"}: could not load (${live.error})`;
                  warn = true;
                } else if (d?.status === "product_removed") {
                  line = "Product removed. The table will be empty.";
                  warn = true;
                } else if (d?.status === "no_formula") {
                  line = `${d.productName}: no finalized formula yet. The table will be empty.`;
                  warn = true;
                } else line = `${d?.productName}: formula v${d?.status === "ok" ? d.versionNumber : "?"}${d?.status === "ok" && d.bomDiffers ? " (Products & BOM differs from this formula)" : ""}`;
                return (
                  <li key={t.nodeId} className={warn ? "rounded border border-amber-400 bg-amber-50 px-2 py-1" : ""}>
                    Table {i + 1}: {warn ? "⚠ " : ""}
                    {line}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-1">The current numbers are frozen into this version. Later formula changes publish a new version automatically.</p>
        </div>
        {error && <p className="text-red-600" role="alert">{error}</p>}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-black">
          Cancel
        </button>
        <button type="button" onClick={submit} disabled={busy} className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-60">
          {busy ? "Publishing…" : "Publish"}
        </button>
      </div>
    </Modal>
  );
}
