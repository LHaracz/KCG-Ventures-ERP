/**
 * Server-side SOP document operations (service-role client only):
 * publishing, frozen formula snapshots, and automatic versions when a
 * product's formula changes. Every write that creates a version goes
 * through the sop_publish_version() database function, which does the
 * whole thing in one transaction.
 *
 * Never logs SOP body text or formula amounts.
 */
import { extractSearchText, findFormulaTables, validateSopDocument, type DocNode } from "@/lib/sopDocument";
import {
  loadLatestFinalFormulations,
  loadProductFormula,
  snapshotFromFormula,
  type FormulaSnapshot,
  type ProductFormula,
} from "@/lib/sopFormulaData";

type AdminClient = {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => any;
  auth?: { admin?: { getUserById: (id: string) => Promise<{ data: { user: any } | null }> } };
};

export const SOP_TIME_ZONE = "America/New_York";

/** YYYY-MM-DD in America/New_York. */
export function dateInNewYork(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SOP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export class SopError extends Error {
  constructor(message: string, public status = 400, public code?: string) {
    super(message);
  }
}

/** Captures frozen rows for formula tables. Nodes for products not in `onlyProductId` keep `previous` rows. */
export async function captureFormulaSnapshot(
  client: AdminClient,
  doc: DocNode,
  options: { previous?: FormulaSnapshot | null; onlyProductId?: string; capturedAt?: string } = {},
): Promise<{ snapshot: FormulaSnapshot; productIds: string[]; formulas: Map<string, ProductFormula> }> {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const tables = findFormulaTables(doc);
  const formulas = new Map<string, ProductFormula>();
  const snapshot: FormulaSnapshot = {};
  for (const t of tables) {
    const keepPrevious = options.onlyProductId !== undefined && t.productId !== options.onlyProductId && options.previous?.[t.nodeId];
    if (keepPrevious) {
      snapshot[t.nodeId] = options.previous![t.nodeId];
      continue;
    }
    if (!t.productId) {
      snapshot[t.nodeId] = snapshotFromFormula(null, null, capturedAt);
      continue;
    }
    let formula = formulas.get(t.productId);
    if (!formula) {
      formula = await loadProductFormula(client, t.productId);
      formulas.set(t.productId, formula);
    }
    snapshot[t.nodeId] = snapshotFromFormula(formula, t.productId, capturedAt);
  }
  const productIds = Array.from(new Set(tables.map((t) => t.productId).filter((x): x is string => !!x)));
  return { snapshot, productIds, formulas };
}

function rpcErrorToSopError(message: string): SopError {
  if (message.includes("DRAFT_CONFLICT")) return new SopError("This SOP was changed in another session.", 409, "draft_conflict");
  if (message.includes("CURRENT_VERSION_CHANGED")) return new SopError("A newer version was published meanwhile.", 409, "version_conflict");
  return new SopError(message, 500);
}

/** Publish the saved draft as version n+1 (source 'editor'). */
export async function publishDraft(
  client: AdminClient,
  args: {
    sopId: string;
    userId: string | null;
    changeNote: string;
    effectiveDate: string;
    publishedByName: string;
    expectedRevision: number;
  },
): Promise<{ versionId: string }> {
  if (!args.changeNote.trim()) throw new SopError("A change note is required.");
  if (!args.publishedByName.trim()) throw new SopError("Choose who is publishing.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.effectiveDate)) throw new SopError("Effective date is invalid.");

  const { data: sop, error } = await client
    .from("sops")
    .select("id, draft_content, draft_revision")
    .eq("id", args.sopId)
    .maybeSingle();
  if (error) throw new SopError(error.message, 500);
  if (!sop) throw new SopError("SOP not found.", 404);
  if (!sop.draft_content) throw new SopError("There is no draft to publish.");
  if (sop.draft_revision !== args.expectedRevision) throw new SopError("This SOP was changed in another session.", 409, "draft_conflict");

  const valid = validateSopDocument(sop.draft_content);
  if (!valid.ok) throw new SopError(valid.error);

  const { snapshot, productIds } = await captureFormulaSnapshot(client, valid.doc);
  const { data: versionId, error: rpcError } = await client.rpc("sop_publish_version", {
    p_sop_id: args.sopId,
    p_content: valid.doc,
    p_formula_snapshot: snapshot,
    p_source: "editor",
    p_published_by_name: args.publishedByName.trim(),
    p_change_note: args.changeNote.trim(),
    p_effective_date: args.effectiveDate,
    p_search_text: extractSearchText(valid.doc),
    p_trigger_formulation_id: null,
    p_product_ids: productIds,
    p_clear_draft: true,
    p_expected_draft_revision: args.expectedRevision,
    p_expected_current_version_id: null,
    p_user_id: args.userId,
    p_set_format_document: true,
    p_set_product_id: null,
  });
  if (rpcError) throw rpcErrorToSopError(rpcError.message);
  return { versionId: versionId as string };
}

async function finalizerName(client: AdminClient, userId: string | null): Promise<string> {
  if (!userId || !client.auth?.admin) return "System";
  try {
    const { data } = await client.auth.admin.getUserById(userId);
    const u = data?.user;
    const meta = (u?.user_metadata ?? {}) as Record<string, unknown>;
    const name = (meta.full_name || meta.name || u?.email) as string | undefined;
    return name && String(name).trim() ? String(name).trim() : "System";
  } catch {
    return "System";
  }
}

export type SyncResult = { sopId: string; outcome: "created" | "up_to_date" | "skipped"; versionId?: string; reason?: string };

/**
 * For each published document SOP whose current version uses `productId`,
 * create an automatic version if its snapshot for that product does not
 * already use `formulationId`. Content is the current version's content,
 * copied exactly. Idempotent (unique (sop_id, trigger_formulation_id)).
 */
export async function syncSopFormulaTables(client: AdminClient, productId: string, formulationId: string): Promise<SyncResult[]> {
  const formula = await loadProductFormula(client, productId);
  if (formula.status !== "ok" || formula.formulationId !== formulationId) {
    // Only the product's latest final formulation may drive SOP tables.
    return [];
  }

  const { data: refs, error: refError } = await client
    .from("sop_formula_refs")
    .select("sop_id")
    .eq("product_id", productId)
    .eq("active", true);
  if (refError) throw new SopError(refError.message, 500);
  const sopIds = Array.from(new Set(((refs ?? []) as { sop_id: string }[]).map((r) => r.sop_id)));
  if (sopIds.length === 0) return [];

  const { data: sops, error: sopError } = await client
    .from("sops")
    .select("id, format, archived_at")
    .in("id", sopIds);
  if (sopError) throw new SopError(sopError.message, 500);

  const results: SyncResult[] = [];
  const publishedBy = await finalizerName(client, formula.finalizedBy);
  const effectiveDate = dateInNewYork(formula.finalizedAt ? new Date(formula.finalizedAt) : new Date());

  for (const sop of (sops ?? []) as { id: string; format: string; archived_at: string | null }[]) {
    if (sop.format !== "document" || sop.archived_at) {
      results.push({ sopId: sop.id, outcome: "skipped", reason: sop.archived_at ? "archived" : "not a document" });
      continue;
    }
    const { data: current, error: curError } = await client
      .from("sop_versions")
      .select("id, content, formula_snapshot")
      .eq("sop_id", sop.id)
      .eq("is_current", true)
      .maybeSingle();
    if (curError) throw new SopError(curError.message, 500);
    if (!current?.content) {
      results.push({ sopId: sop.id, outcome: "skipped", reason: "no published document version" });
      continue;
    }
    const content = current.content as DocNode;
    const previous = (current.formula_snapshot ?? {}) as FormulaSnapshot;
    const nodes = findFormulaTables(content).filter((t) => t.productId === productId);
    if (nodes.length === 0) {
      results.push({ sopId: sop.id, outcome: "skipped", reason: "no table for this product" });
      continue;
    }
    if (nodes.every((n) => previous[n.nodeId]?.formulationId === formulationId)) {
      results.push({ sopId: sop.id, outcome: "up_to_date" });
      continue;
    }

    const oldVersions = Array.from(
      new Set(nodes.map((n) => previous[n.nodeId]?.versionNumber).filter((v): v is number => typeof v === "number")),
    );
    const { snapshot } = await captureFormulaSnapshot(client, content, { previous, onlyProductId: productId });
    const oldLabel = oldVersions.length ? oldVersions.map((v) => `v${v}`).join("/") : "none";
    const summary = (formula.changeSummary ?? "").trim();
    const changeNote =
      `Formula table updated automatically: ${formula.productName} formula ${oldLabel} to v${formula.versionNumber}.` +
      (summary ? ` ${summary}` : "");

    const { data: versionId, error: rpcError } = await client.rpc("sop_publish_version", {
      p_sop_id: sop.id,
      p_content: content, // exact copy of the current published content
      p_formula_snapshot: snapshot,
      p_source: "auto_formula_update",
      p_published_by_name: publishedBy,
      p_change_note: changeNote,
      p_effective_date: effectiveDate,
      p_search_text: extractSearchText(content),
      p_trigger_formulation_id: formulationId,
      p_product_ids: Array.from(new Set(findFormulaTables(content).map((t) => t.productId).filter(Boolean))),
      p_clear_draft: false, // a pending draft is never touched
      p_expected_draft_revision: null,
      p_expected_current_version_id: current.id,
      p_user_id: null,
      p_set_format_document: false,
      p_set_product_id: null,
    });
    if (rpcError) {
      if (rpcError.message.includes("CURRENT_VERSION_CHANGED")) {
        results.push({ sopId: sop.id, outcome: "skipped", reason: "current version changed during sync; reconcile will retry" });
        continue;
      }
      throw new SopError(rpcError.message, 500);
    }
    results.push(versionId ? { sopId: sop.id, outcome: "created", versionId: versionId as string } : { sopId: sop.id, outcome: "up_to_date" });
  }
  return results;
}

/** Catches missed updates: runs sync for every product referenced by the given SOPs (or all). */
export async function reconcileSopFormulaTables(client: AdminClient, sopIds?: string[]): Promise<SyncResult[]> {
  let q = client.from("sop_formula_refs").select("sop_id, product_id").eq("active", true);
  if (sopIds && sopIds.length) q = q.in("sop_id", sopIds);
  const { data, error } = await q;
  if (error) throw new SopError(error.message, 500);
  const productIds = Array.from(new Set(((data ?? []) as { product_id: string }[]).map((r) => r.product_id)));
  const latest = await loadLatestFinalFormulations(client, productIds);
  const results: SyncResult[] = [];
  for (const [productId, f] of latest) {
    const r = await syncSopFormulaTables(client, productId, f.formulationId);
    results.push(...(sopIds && sopIds.length ? r.filter((x) => sopIds.includes(x.sopId)) : r));
  }
  return results;
}

/** Which SOPs use a product, and whether each is behind the latest final formula. */
export async function sopsUsingProduct(
  client: AdminClient,
  productId: string,
): Promise<{ sopId: string; title: string; sopNumber: string | null; versionNumber: number | null; upToDate: boolean }[]> {
  const { data: refs, error } = await client.from("sop_formula_refs").select("sop_id").eq("product_id", productId).eq("active", true);
  if (error) throw new SopError(error.message, 500);
  const ids = Array.from(new Set(((refs ?? []) as { sop_id: string }[]).map((r) => r.sop_id)));
  if (!ids.length) return [];
  const [{ data: sops }, { data: versions }, latestMap] = await Promise.all([
    client.from("sops").select("id, title, sop_number, archived_at, format").in("id", ids),
    client.from("sop_versions").select("sop_id, version_number, formula_snapshot, content").in("sop_id", ids).eq("is_current", true),
    loadLatestFinalFormulations(client, [productId]),
  ]);
  const latest = latestMap.get(productId);
  return ((sops ?? []) as { id: string; title: string; sop_number: string | null; archived_at: string | null; format: string }[])
    .filter((s) => !s.archived_at && s.format === "document")
    .map((s) => {
      const v = ((versions ?? []) as any[]).find((x) => x.sop_id === s.id);
      const snap = (v?.formula_snapshot ?? {}) as FormulaSnapshot;
      const nodes = findFormulaTables(v?.content).filter((t) => t.productId === productId);
      const upToDate = !latest || nodes.every((n) => snap[n.nodeId]?.formulationId === latest.formulationId);
      return { sopId: s.id, title: s.title, sopNumber: s.sop_number, versionNumber: v?.version_number ?? null, upToDate };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
