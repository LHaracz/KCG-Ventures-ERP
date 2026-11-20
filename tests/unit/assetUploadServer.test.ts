// Server side of uploads: the signed-URL step and the verification step,
// with an invented in-memory storage. Invented data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssetUploadUrl, finalizeUpload } from "@/lib/growth/marketingService";

const MB = 1024 * 1024;
const files = new Map<string, Uint8Array>();
const removed: string[] = [];
const inserted: Array<Record<string, unknown>> = [];

function fakeDb() {
  const bucket = {
    createSignedUploadUrl: async (path: string) => ({ data: { path, token: "t", signedUrl: `https://storage.example.test/upload/${path}` }, error: null }),
    createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.example.test/object/${path}` }, error: null }),
    remove: async (paths: string[]) => {
      removed.push(...paths);
      paths.forEach((p) => files.delete(p));
      return { error: null };
    },
  };
  const table = {
    insert: (row: Record<string, unknown>) => {
      inserted.push(row);
      return { select: () => ({ single: async () => ({ data: { id: "00000000-0000-4000-8000-000000000001", ...row }, error: null }) }) };
    },
    select: () => table,
    delete: () => table,
    eq: async () => ({ data: [], error: null }),
    in: async () => ({ data: [], error: null }),
  };
  return { storage: { from: () => bucket }, from: () => table };
}

beforeEach(() => {
  files.clear();
  removed.length = 0;
  inserted.length = 0;
  // Ranged reads of the in-memory files (like Supabase Storage with Range: bytes=0-31).
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace("https://storage.example.test/object/", "");
    const f = files.get(path);
    if (!f) return new Response("not found", { status: 400 });
    return new Response(f.slice(0, 32), { status: 206, headers: { "content-range": `bytes 0-31/${f.length}` } });
  });
});
afterEach(() => vi.unstubAllGlobals());

const rejects = async (fn: () => Promise<unknown>, re: RegExp) => {
  let msg = "";
  try {
    await fn();
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(re);
};
const enc = (s: string) => new TextEncoder().encode(s);
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...enc("ftypmp42"), 0, 0, 0, 0, ...enc("isommp42"), 0, 0, 0, 8]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 1, 2]);
const fields = { title: "Clip A", category: "market", asset_type: "video" };

describe("signed upload URLs", () => {
  it("rejects a type that isn't allowed and an oversize declared size", async () => {
    const db = fakeDb();
    await rejects(() => createAssetUploadUrl(db, { mime_type: "video/quicktime", size_bytes: 10 }), /Only PNG, JPG, WebP, PDF, HEIC, GIF and MP4/);
    await rejects(() => createAssetUploadUrl(db, { mime_type: "image/svg+xml", size_bytes: 10 }), /Only PNG/);
    await rejects(() => createAssetUploadUrl(db, { mime_type: "video/mp4", size_bytes: 200 * MB + 1 }), /MP4 files can be up to 200 MB/);
    await rejects(() => createAssetUploadUrl(db, { mime_type: "image/gif", size_bytes: 50 * MB + 1 }), /GIF files can be up to 50 MB/);
    await rejects(() => createAssetUploadUrl(db, { mime_type: "image/heic", size_bytes: 25 * MB + 1 }), /HEIC files can be up to 25 MB/);
    await rejects(() => createAssetUploadUrl(db, { mime_type: "image/png", size_bytes: 10, extra: "poster", extra_size_bytes: 5 }), /no preview/);
  });

  it("issues one URL for the original and one for its poster", async () => {
    const r = await createAssetUploadUrl(fakeDb(), { mime_type: "video/mp4", size_bytes: 200 * MB, extra: "poster", extra_size_bytes: 1000 });
    expect(r.path).toMatch(/^assets\/\d{4}-\d{2}\/[0-9a-f-]{36}\.mp4$/);
    expect(r.extra).toMatchObject({ kind: "poster", path: `${r.path}.poster.jpg` });
  });
});

describe("verification", () => {
  it("saves an MP4 with its poster, size and duration", async () => {
    const db = fakeDb();
    const up = await createAssetUploadUrl(db, { mime_type: "video/mp4", size_bytes: MP4.length, extra: "poster", extra_size_bytes: JPG.length });
    files.set(up.path, MP4);
    files.set(up.extra!.path, JPG);
    await finalizeUpload(db, { ...fields, path: up.path, mime_type: "video/mp4", poster_path: up.extra!.path, width: 1080, height: 1920, duration_seconds: 12.345 }, "Test Person");
    expect(inserted[0]).toMatchObject({ file_path: up.path, mime_type: "video/mp4", size_bytes: MP4.length, poster_path: up.extra!.path, preview_path: null, width: 1080, height: 1920, duration_seconds: 12.35 });
    expect(removed).toEqual([]);
  });

  it("deletes the uploaded objects when the bytes don't match", async () => {
    const db = fakeDb();
    const up = await createAssetUploadUrl(db, { mime_type: "video/mp4", size_bytes: 20, extra: "poster", extra_size_bytes: JPG.length });
    files.set(up.path, enc("this is only some text, not a video at all"));
    files.set(up.extra!.path, JPG);
    await rejects(() => finalizeUpload(db, { ...fields, path: up.path, mime_type: "video/mp4", poster_path: up.extra!.path }, null), /isn't a real MP4/);
    expect(removed.sort()).toEqual([up.path, up.extra!.path].sort());
    expect(inserted).toEqual([]);
  });

  it("deletes the objects when the poster isn't a JPG", async () => {
    const db = fakeDb();
    const up = await createAssetUploadUrl(db, { mime_type: "video/mp4", size_bytes: MP4.length, extra: "poster", extra_size_bytes: 5 });
    files.set(up.path, MP4);
    files.set(up.extra!.path, enc("<svg>"));
    await rejects(() => finalizeUpload(db, { ...fields, path: up.path, mime_type: "video/mp4", poster_path: up.extra!.path }, null), /preview image is missing or not valid/);
    expect(removed.sort()).toEqual([up.path, up.extra!.path].sort());
  });
});

describe("slow storage", () => {
  it("never hangs: a check that gets no answer gives up, removes the objects and says so", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Storage that accepts the request but never sends anything back.
      vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      );
      const db = fakeDb();
      const up = await createAssetUploadUrl(db, { mime_type: "video/mp4", size_bytes: MP4.length });
      files.set(up.path, MP4);
      const done = finalizeUpload(db, { ...fields, path: up.path, mime_type: "video/mp4" }, null).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(((await done) as Error).message).toMatch(/took too long/);
      expect(removed).toEqual([up.path]);
      expect(inserted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads only the first bytes when storage ignores the range and starts sending the whole file", async () => {
    let pulled = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const f = files.get(url.replace("https://storage.example.test/object/", ""))!;
      // An endless body: 64 KB chunks forever, like a very large file.
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          const chunk = new Uint8Array(64 * 1024);
          if (pulled === 1) chunk.set(f);
          c.enqueue(chunk);
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": String(150 * MB) } });
    });
    const db = fakeDb();
    const up = await createAssetUploadUrl(db, { mime_type: "video/mp4", size_bytes: 150 * MB });
    files.set(up.path, MP4);
    await finalizeUpload(db, { ...fields, path: up.path, mime_type: "video/mp4" }, null);
    expect(inserted[0]).toMatchObject({ size_bytes: 150 * MB, mime_type: "video/mp4" });
    expect(pulled).toBeLessThan(5);
  });
});
