"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { DocumentViewerModal, type DocumentViewerTarget } from "@/components/DocumentViewerModal";
import { formatDate } from "@/lib/date";
import { DOCUMENT_TYPES, type LogEntryFile } from "@/lib/complianceLogs";

const PAGE_SIZE = 20;

type CoaRow = {
  entryId: string;
  entryNumber: number;
  performedAt: string;
  ingredient: string;
  rawMaterialId: string;
  supplier: string;
  supplierLotNumber: string;
  internalLotId: string;
  coaReceived: boolean;
  files: LogEntryFile[];
};

export default function CoasPage() {
  const { user, supabase } = useSupabase();

  const [rows, setRows] = useState<CoaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ingredientFilter, setIngredientFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");
  const [showWithoutDocs, setShowWithoutDocs] = useState(false);
  const [page, setPage] = useState(1);

  const [viewerTarget, setViewerTarget] = useState<DocumentViewerTarget | null>(null);

  const getToken = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Unable to verify your session.");
    return token;
  };

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data: typeRow, error: typeError } = await supabase
          .from("log_types")
          .select("id")
          .eq("special_type", "receiving")
          .maybeSingle();
        if (typeError) throw new Error(typeError.message);
        if (!typeRow) {
          setRows([]);
          return;
        }

        const { data, error } = await supabase
          .from("log_entries")
          .select(
            "id, entry_number, performed_at, receiving_details(raw_material_id, supplier, supplier_lot_number, internal_lot_id, coa_received, inventory_items(name)), log_entry_files(id, log_entry_id, file_path, original_filename, file_size_bytes, document_type, label, added_at, added_by_name, added_after_submit)",
          )
          .eq("log_type_id", typeRow.id)
          .order("performed_at", { ascending: false })
          .limit(1000);
        if (error) throw new Error(error.message);

        const mapped: CoaRow[] = ((data ?? []) as any[])
          .filter((e) => e.receiving_details)
          .map((e) => ({
            entryId: e.id,
            entryNumber: e.entry_number,
            performedAt: e.performed_at,
            ingredient: e.receiving_details.inventory_items?.name ?? "Unknown material",
            rawMaterialId: e.receiving_details.raw_material_id,
            supplier: e.receiving_details.supplier,
            supplierLotNumber: e.receiving_details.supplier_lot_number,
            internalLotId: e.receiving_details.internal_lot_id,
            coaReceived: e.receiving_details.coa_received,
            files: (e.log_entry_files ?? []) as LogEntryFile[],
          }));
        setRows(mapped);
      } catch (err: any) {
        setLoadError(err.message || "Failed to load COAs.");
      } finally {
        setLoading(false);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const ingredients = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.rawMaterialId, r.ingredient);
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const isCoaMissing = (row: CoaRow) => row.coaReceived && !row.files.some((f) => f.document_type === "coa");

  const filteredRows = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (!showWithoutDocs && row.files.length === 0) return false;
      if (ingredientFilter && row.rawMaterialId !== ingredientFilter) return false;
      if (dateFrom && row.performedAt < dateFrom) return false;
      if (dateTo && row.performedAt > `${dateTo}T23:59:59`) return false;
      if (
        searchLower &&
        !row.supplier.toLowerCase().includes(searchLower) &&
        !row.supplierLotNumber.toLowerCase().includes(searchLower)
      ) {
        return false;
      }
      return true;
    });
  }, [rows, ingredientFilter, dateFrom, dateTo, search, showWithoutDocs]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const fileLabel = (file: LogEntryFile) => {
    const typeLabel = DOCUMENT_TYPES.find((t) => t.value === file.document_type)?.label ?? file.document_type;
    return file.label ? `${typeLabel} — ${file.label}` : `${typeLabel} — ${file.original_filename}`;
  };

  const openFileViewer = (row: CoaRow, file: LogEntryFile) => {
    setViewerTarget({
      fileName: file.original_filename,
      title: `${row.ingredient} — ${fileLabel(file)}`,
      fetchSignedUrl: async (opts) => {
        const token = await getToken();
        const url = `/api/compliance/logs/entries/${row.entryId}/documents/${file.id}/signed-url${opts?.download ? "?download=1" : ""}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || "Failed to load this file.");
        return payload.url as string;
      },
    });
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-6xl space-y-4">
        <header>
          <h1 className="text-2xl font-semibold text-zinc-900">COAs</h1>
          <p className="text-sm text-black">
            Certificates of analysis and other documents attached to receiving entries.{" "}
            <Link href="/compliance/logs/receiving" className="font-medium text-emerald-700 underline">
              Go to Receiving log
            </Link>
          </p>
        </header>

        <div className="flex flex-wrap items-end gap-3 rounded-md border border-zinc-200 bg-white p-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-zinc-700">Ingredient</label>
            <select
              value={ingredientFilter}
              onChange={(e) => {
                setIngredientFilter(e.target.value);
                setPage(1);
              }}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-black shadow-sm"
            >
              <option value="">All</option>
              {ingredients.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-zinc-700">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-black shadow-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-zinc-700">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-black shadow-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-zinc-700">Search supplier / lot</label>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-black shadow-sm"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-black">
            <input
              type="checkbox"
              checked={showWithoutDocs}
              onChange={(e) => {
                setShowWithoutDocs(e.target.checked);
                setPage(1);
              }}
              className="h-3.5 w-3.5"
            />
            Show receipts without documents
          </label>
        </div>

        <section className="rounded-md border border-zinc-200 bg-white p-4">
          {loading ? (
            <p className="text-xs text-black">Loading…</p>
          ) : loadError ? (
            <p className="text-xs text-red-600" role="alert">
              {loadError}
            </p>
          ) : pageRows.length === 0 ? (
            <p className="text-xs text-black">No receipts match these filters.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-left text-xs">
                  <thead className="bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Ingredient</th>
                      <th className="px-2 py-1.5 font-medium">Date submitted</th>
                      <th className="px-2 py-1.5 font-medium">Supplier / lot</th>
                      <th className="px-2 py-1.5 font-medium">Files</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row) => (
                      <tr key={row.entryId} className="border-b border-zinc-100 align-top">
                        <td className="px-2 py-1.5 text-zinc-700">
                          <Link href={`/compliance/logs/entries/${row.entryId}`} className="font-medium text-emerald-700 underline">
                            {row.ingredient}
                          </Link>
                          {isCoaMissing(row) && (
                            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700">
                              COA missing
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-zinc-700">{formatDate(row.performedAt)}</td>
                        <td className="px-2 py-1.5 text-zinc-700">
                          {row.supplier}
                          <div className="text-[11px] text-zinc-500">
                            Lot {row.supplierLotNumber} · {row.internalLotId}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          {row.files.length === 0 ? (
                            <span className="text-zinc-400">No documents</span>
                          ) : (
                            <div className="flex flex-col gap-1">
                              {row.files.map((file) => (
                                <button
                                  key={file.id}
                                  type="button"
                                  onClick={() => openFileViewer(row, file)}
                                  className="text-left text-emerald-700 underline"
                                >
                                  {fileLabel(file)}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {pageCount > 1 && (
                <div className="mt-3 flex items-center justify-between text-xs text-zinc-700">
                  <span>
                    Page {currentPage} of {pageCount} ({filteredRows.length} receipts)
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage <= 1}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                      disabled={currentPage >= pageCount}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {viewerTarget && <DocumentViewerModal target={viewerTarget} onClose={() => setViewerTarget(null)} />}
      </div>
    </AuthGuard>
  );
}
