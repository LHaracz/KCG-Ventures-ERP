// Marketing Hub server code against the real migrations in PGlite: profiles
// (primary photo must be an uploaded image), the claim workflow (review
// trigger, reset to draft, history; the non-Admin trigger check is in
// marketingSales.db), uploads (file signature check, removal
// of bad files), the post Ready gate, templates and the risky-word list.
// Invented products ("Product A") and example.test links only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, createAccessDb, migration } from "./helpers/accessDb";
import { pgliteSupabase } from "./helpers/pgliteSupabase";
import {
  createAssetUploadUrl,
  createClaim,
  createLinkAsset,
  finalizeUpload,
  loadMarketing,
  reviewClaim,
  saveProfile,
  savePost,
  saveRiskyWord,
  saveTemplate,
  sniffMime,
  submitClaim,
  updateAsset,
  updateClaim,
} from "@/lib/growth/marketingService";
import type { Db } from "@/lib/growth/routeHelpers";

let pg: PGlite;
let db: Db;
let fp: string;
const files = new Map<string, Uint8Array>();
const removed: string[] = [];

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%test");
const WEBP = new TextEncoder().encode("RIFF\x10\x00\x00\x00WEBPVP8 ");

const rejects = async (fn: () => Promise<unknown>, re: RegExp) => {
  let err: unknown = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err, "expected an error").toBeTruthy();
  expect((err as Error).message).toMatch(re);
  return err as Error & { fields?: Record<string, string>; status?: number };
};

/** A stand-in for Supabase Storage: files keyed by path. */
function withStorage(base: Db): Db {
  const bucket = {
    createSignedUploadUrl: async (path: string) => ({ data: { path, token: "t", signedUrl: `https://storage.example.test/${path}` }, error: null }),
    download: async (path: string) => (files.has(path) ? { data: new Blob([files.get(path)! as BlobPart]), error: null } : { data: null, error: { message: "not found" } }),
    remove: async (paths: string[]) => {
      removed.push(...paths);
      paths.forEach((p) => files.delete(p));
      return { error: null };
    },
    createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.example.test/signed/${path}` }, error: null }),
  };
  return Object.assign(base, { storage: { from: () => bucket } });
}

async function upload(bytes: Uint8Array, mime: string, title = "Photo A") {
  const { path } = await createAssetUploadUrl(db, { mime_type: mime, size_bytes: bytes.length });
  files.set(path, bytes);
  return finalizeUpload(db, { path, mime_type: mime, title, category: "product", product_ids: [fp] }, "Test Person");
}

beforeEach(async () => {
  // Ranged reads of the stand-in storage (the server reads only the first bytes).
  vi.stubGlobal("fetch", async (url: string) => {
    const f = files.get(url.replace("https://storage.example.test/signed/", ""));
    if (!f) return new Response("not found", { status: 400 });
    return new Response(f.slice(0, 32), { status: 206, headers: { "content-range": `bytes 0-31/${f.length}` } });
  });
  files.clear();
  removed.length = 0;
  ({ pg } = await createAccessDb());
  await asOwner(pg);
  await pg.exec(`
    alter table products add column if not exists unit text;
    alter table products add column if not exists sale_price_per_unit numeric;
    alter table products add column if not exists deleted_at timestamptz;
    alter table products add column if not exists is_microgreen boolean default false;
  `);
  for (const f of ["formulation.sql", "procurement_suppliers.sql", "retail_invoices.sql", "marketing_sales.sql", "ad_library.sql", "marketing_assets_media.sql", "marketing_assets_mov.sql"]) await pg.exec(migration(f));
  db = withStorage(pgliteSupabase(pg) as unknown as Db);
  fp = (await pg.query<{ id: string }>(`insert into formulation_products (name) values ('Product A') returning id`)).rows[0].id;
  await pg.query(`insert into formulation_products (name, deleted_at) values ('Product Gone', now())`);
}, 120_000);

describe("file signatures", () => {
  it("recognises PNG, JPEG, WebP and PDF and nothing else", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(WEBP)).toBe("image/webp");
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(new TextEncoder().encode("<html>"))).toBeNull();
    expect(sniffMime(new Uint8Array([]))).toBeNull();
  });
});

describe("assets", () => {
  it("uploads are checked on the server; links are stored as links", async () => {
    await rejects(() => createAssetUploadUrl(db, { mime_type: "video/webm", size_bytes: 10 }), /Paste a link for other videos/);
    await rejects(() => createAssetUploadUrl(db, { mime_type: "image/png", size_bytes: 26 * 1024 * 1024 }), /25 MB/);
    const a = await upload(PNG, "image/png");
    expect(a).toMatchObject({ source: "upload", mime_type: "image/png", size_bytes: PNG.length, status: "draft", created_by_name: "Test Person" });
    // A file whose bytes don't match its stated type is removed and not saved.
    const { path } = await createAssetUploadUrl(db, { mime_type: "image/png", size_bytes: 6 });
    files.set(path, new TextEncoder().encode("<html>"));
    await rejects(() => finalizeUpload(db, { path, mime_type: "image/png", title: "Fake", category: "other", context_label: "Test" }, null), /isn't a real PNG/);

    expect(removed).toEqual([path]);
    await rejects(() => finalizeUpload(db, { path: "../../etc/passwd", mime_type: "image/png", title: "x" }, null), /Unknown upload/);
    const link = await createLinkAsset(db, { title: "Reel A", asset_type: "video", url: "https://video.example.test/a", category: "other", context_label: "Reel" }, null);
    expect(link).toMatchObject({ source: "link", url: "https://video.example.test/a" });
    await rejects(() => createLinkAsset(db, { title: "Reel B", url: "javascript:alert(1)", category: "other", context_label: "Reel" }, null), /missing or not valid/);
    expect((await updateAsset(db, link.id, { status: "ready" })).status).toBe("ready");
    expect((await updateAsset(db, link.id, { status: "archived" })).status).toBe("archived");
  });
});

describe("profiles", () => {
  it("saves a profile; the primary photo must be an uploaded image", async () => {
    const photo = await upload(PNG, "image/png");
    const pdf = await upload(PDF, "application/pdf", "Sheet A");
    await rejects(() => saveProfile(db, fp, { primary_asset_id: pdf.id }, null), /missing or not valid/);
    const p = await saveProfile(db, fp, { tagline: "Fresh breath, simply", primary_asset_id: photo.id }, "Test Person");
    expect(p).toMatchObject({ tagline: "Fresh breath, simply", primary_asset_id: photo.id, updated_by_name: "Test Person" });
    const again = await saveProfile(db, fp, { tagline: "Tagline B" }, null);
    expect(again.id).toBe(p.id); // one profile per product
    await rejects(() => saveProfile(db, fp, { tagline: "x".repeat(151) }, null), /missing or not valid/);
    const m = await loadMarketing(db);
    expect(m.products.map((x) => x.name)).toEqual(["Product A"]); // deleted products are left out
    expect(m.riskyWords.length).toBeGreaterThan(10);
  });
});

describe("claims", () => {
  it("draft → review → approved; editing the text resets it; history is kept", async () => {
    const c = await createClaim(db, { claim_text: "Made with ingredient A", claim_type: "ingredient_fact", formulation_product_id: fp }, "Test Person");
    expect(c.status).toBe("draft");
    expect((await submitClaim(db, c.id, "Test Person")).status).toBe("in_review");
    await rejects(() => reviewClaim(db, c.id, { action: "reject" }, "Admin A"), /note explaining/);
    const ok = await reviewClaim(db, c.id, { action: "approve", review_again_on: "2027-11-17" }, "Admin A");
    expect(ok).toMatchObject({ status: "approved", reviewed_by_name: "Admin A", review_again_on: expect.anything() });
    const edited = await updateClaim(db, c.id, { claim_text: "Made with ingredient A and B", claim_type: "ingredient_fact", formulation_product_id: fp }, "Test Person");
    expect(edited.status).toBe("draft");
    expect(edited.reviewed_by_name).toBeNull();
    await submitClaim(db, c.id, null);
    await reviewClaim(db, c.id, { action: "reject", note: "Needs a source" }, "Admin A");
    expect((await reviewClaim(db, c.id, { action: "retire" }, "Admin A")).status).toBe("retired");
    await rejects(() => updateClaim(db, c.id, { claim_text: "x" }, null), /Retired/);
    const events = (await loadMarketing(db)).claimEvents.filter((e) => e.claim_id === c.id).map((e) => e.event);
    for (const e of ["created", "submitted", "approved", "reset_to_draft", "rejected", "retired"]) expect(events).toContain(e);
  });
});

describe("posts", () => {
  it("the Ready gate: caption, approved claims, risky words acknowledged", async () => {
    const draft = await createClaim(db, { claim_text: "Claim draft" }, null);
    const good = await createClaim(db, { claim_text: "Claim approved", submit: true }, null);
    await reviewClaim(db, good.id, { action: "approve" }, "Admin A");
    const base = { title: "Post A", platform: "instagram", post_type: "reel", formulation_product_id: fp };
    const idea = await savePost(db, null, { ...base, claim_ids: [draft.id] }, "Test Person"); // ideas aren't gated
    await rejects(() => savePost(db, idea.id, { ...base, status: "ready", claim_ids: [draft.id] }, null), /Write the caption/);
    await rejects(() => savePost(db, idea.id, { ...base, status: "ready", caption: "Hello", claim_ids: [draft.id] }, null), /aren't approved yet: "Claim draft"/);
    await rejects(() => savePost(db, idea.id, { ...base, status: "scheduled", caption: "This will cure everything", claim_ids: [good.id] }, null), /Check these words first/);
    const ok = await savePost(db, idea.id, { ...base, status: "scheduled", scheduled_date: "2026-12-01", scheduled_time: "09:30", caption: "This will cure everything", claim_ids: [good.id], risky_words_checked: true }, null);
    expect(ok.warnings.length).toBeGreaterThan(0);
    const post = (await loadMarketing(db)).posts.find((p) => p.id === idea.id)!;
    expect(post).toMatchObject({ status: "scheduled", scheduled_date: "2026-12-01", scheduled_time: "09:30", claim_ids: [good.id], risky_words_checked: true });
    await rejects(() => savePost(db, null, { ...base, scheduled_time: "25:00" }, null), /missing or not valid/);
  });
});

describe("templates and the risky-word list", () => {
  it("validates, archives and blocks duplicate words", async () => {
    await saveTemplate(db, null, { name: "Launch", body: "Meet {product_name}. {tagline}" });
    await rejects(() => saveTemplate(db, null, { name: "", body: "" }), /missing or not valid/);
    const t = (await loadMarketing(db)).templates[0];
    await saveTemplate(db, t.id, { archive: true });
    expect((await loadMarketing(db)).templates[0].archived_at).not.toBeNull();
    await saveRiskyWord(db, null, { phrase: "  miracle   worker " });
    await rejects(() => saveRiskyWord(db, null, { phrase: "Miracle Worker" }), /already on the list/);
    const w = (await loadMarketing(db)).riskyWords.find((x) => x.phrase === "miracle worker")!;
    await saveRiskyWord(db, w.id, { archive: true });
    expect((await loadMarketing(db)).riskyWords.find((x) => x.id === w.id)!.archived_at).not.toBeNull();
  });
});
