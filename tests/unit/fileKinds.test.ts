// detectFileKind and sizeLimitFor, with invented byte arrays only.
import { describe, expect, it } from "vitest";
import { SIZE_LIMITS, detectFileKind, sizeError, sizeLimitFor } from "@/lib/growth/fileKinds";

const MB = 1024 * 1024;
const bytes = (...parts: Array<string | number[]>) => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p));
  return new Uint8Array(out);
};
const ftyp = (brand: string) => bytes([0, 0, 0, 0x18], "ftyp", brand, [0, 0, 0, 0], "mif1heic");
const PNG = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = bytes("RIFF", [0x10, 0, 0, 0], "WEBPVP8 ");
const PDF = bytes("%PDF-1.7\n");
const GIF = bytes("GIF89a", [1, 0, 1, 0]);
const detect = (name: string, firstBytes: Uint8Array, declaredType = "") => detectFileKind({ name, declaredType, firstBytes });

describe("detectFileKind", () => {
  it("recognises every kind by its bytes", () => {
    expect(detect("a.png", PNG)).toEqual({ ok: true, file: { kind: "image", mime: "image/png", extension: "png" } });
    expect(detect("a.jpeg", JPG)).toEqual({ ok: true, file: { kind: "image", mime: "image/jpeg", extension: "jpg" } });
    expect(detect("a.webp", WEBP)).toEqual({ ok: true, file: { kind: "image", mime: "image/webp", extension: "webp" } });
    expect(detect("a.pdf", PDF)).toEqual({ ok: true, file: { kind: "pdf", mime: "application/pdf", extension: "pdf" } });
    expect(detect("a.gif", GIF)).toEqual({ ok: true, file: { kind: "gif", mime: "image/gif", extension: "gif" } });
    expect(detect("a.gif", bytes("GIF87a", [1, 0]))).toMatchObject({ ok: true, file: { kind: "gif" } });
    for (const brand of ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]) {
      expect(detect("Photo A.HEIC", ftyp(brand))).toEqual({ ok: true, file: { kind: "heic", mime: "image/heic", extension: "heic" } });
    }
    expect(detect("Photo A.heif", ftyp("mif1"))).toEqual({ ok: true, file: { kind: "heic", mime: "image/heif", extension: "heif" } });
    for (const brand of ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "]) {
      expect(detect("Clip A.mp4", ftyp(brand))).toEqual({ ok: true, file: { kind: "mp4", mime: "video/mp4", extension: "mp4" } });
    }
  });

  it("never relies on the declared type (empty or wrong)", () => {
    expect(detect("Photo A.heic", ftyp("heic"), "")).toMatchObject({ ok: true, file: { mime: "image/heic" } });
    expect(detect("Photo A.heic", ftyp("heic"), "application/octet-stream")).toMatchObject({ ok: true, file: { mime: "image/heic" } });
    expect(detect("a.png", bytes("hello world"), "image/png")).toMatchObject({ ok: false });
  });

  it("accepts real bytes with no extension, and rejects an extension that disagrees", () => {
    expect(detect("upload", GIF)).toMatchObject({ ok: true, file: { kind: "gif" } });
    expect(detect("a.png", JPG)).toEqual({ ok: false, error: expect.stringMatching(/don't match its \.png extension/) });
    expect(detect("Clip A.mp4", ftyp("heic"))).toMatchObject({ ok: false });
    expect(detect("Photo A.heic", ftyp("mp42"))).toMatchObject({ ok: false });
  });

  it("rejects an .mp4 that is really text, and unknown files", () => {
    expect(detect("Clip A.mp4", bytes("just some text, not a video"))).toEqual({ ok: false, error: expect.stringMatching(/isn't a real MP4/) });
    expect(detect("notes.txt", bytes("plain text"))).toEqual({ ok: false, error: expect.stringMatching(/Only PNG, JPG, WebP, PDF, HEIC, GIF, MP4 and MOV/) });
  });

  it("recognises MOV (QuickTime) by its brand, or by its first atom with a .mov extension", () => {
    expect(detect("Clip A.MOV", ftyp("qt  "), "")).toEqual({ ok: true, file: { kind: "mov", mime: "video/quicktime", extension: "mov" } });
    expect(detect("upload", ftyp("qt  "))).toMatchObject({ ok: true, file: { kind: "mov" } });
    for (const atom of ["moov", "mdat", "wide", "free"]) {
      expect(detect("Clip A.mov", bytes([0, 0, 0, 8], atom, [0, 0, 0, 0]))).toMatchObject({ ok: true, file: { kind: "mov" } });
    }
    // Without the .mov extension a bare atom proves nothing.
    expect(detect("Clip A.mp4", bytes([0, 0, 0, 8], "mdat", [0, 0, 0, 0]))).toMatchObject({ ok: false });
  });

  it("lets the extension decide between MP4 and MOV (phones often mix the brands)", () => {
    // An iPhone .mov written with an MP4 brand.
    for (const brand of ["mp42", "isom", "M4V ", "avc1"]) {
      expect(detect("B8978F2D-0000-4000-8000-000000000001.mov", ftyp(brand), "")).toEqual({ ok: true, file: { kind: "mov", mime: "video/quicktime", extension: "mov" } });
    }
    expect(detect("Clip A.mp4", ftyp("qt  "))).toEqual({ ok: true, file: { kind: "mp4", mime: "video/mp4", extension: "mp4" } });
    // Other camera brands count only with a video extension.
    expect(detect("Clip A.mov", ftyp("XAVC"))).toMatchObject({ ok: true, file: { kind: "mov" } });
    expect(detect("Clip A.mp4", ftyp("3gp5"))).toMatchObject({ ok: true, file: { kind: "mp4" } });
    expect(detect("upload", ftyp("XAVC"))).toMatchObject({ ok: false });
    expect(detect("Clip A.png", ftyp("XAVC"))).toMatchObject({ ok: false });
  });

  it("still rejects a HEIC named .mov, an MP4 named .heic, and a .mov that is really text", () => {
    expect(detect("Clip A.mov", ftyp("heic"))).toEqual({ ok: false, error: expect.stringMatching(/don't match its \.mov extension/) });
    expect(detect("Photo A.heic", ftyp("mp42"))).toMatchObject({ ok: false });
    expect(detect("Clip A.mov", bytes("just some text, not a video"))).toEqual({ ok: false, error: expect.stringMatching(/isn't a real MOV/) });
  });

  it("rejects truncated files", () => {
    expect(detect("a.gif", bytes("GIF8"))).toMatchObject({ ok: false });
    expect(detect("Clip A.mp4", bytes([0, 0, 0, 0x18], "ftyp", "mp"))).toMatchObject({ ok: false });
    expect(detect("a.png", PNG.slice(0, 5))).toMatchObject({ ok: false });
    expect(detect("a.webp", WEBP.slice(0, 9))).toMatchObject({ ok: false });
    expect(detect("empty.jpg", new Uint8Array())).toMatchObject({ ok: false });
  });
});

describe("sizeLimitFor", () => {
  it("has one limit per kind", () => {
    expect(SIZE_LIMITS).toEqual({ image: 25 * MB, heic: 25 * MB, pdf: 25 * MB, gif: 50 * MB, mp4: 200 * MB, mov: 200 * MB });
  });
  it.each([
    ["image", 25],
    ["heic", 25],
    ["pdf", 25],
    ["gif", 50],
    ["mp4", 200],
    ["mov", 200],
  ] as const)("%s: %i MB is allowed, one byte more is not", (kind, mb) => {
    expect(sizeLimitFor(kind)).toBe(mb * MB);
    expect(sizeError(kind, mb * MB)).toBeNull();
    expect(sizeError(kind, mb * MB + 1)).toMatch(new RegExp(`${mb} MB`));
  });
  it("tells people to paste a link for big videos, and rejects empty files", () => {
    expect(sizeError("mp4", 200 * MB + 1)).toBe("MP4 files can be up to 200 MB. Paste a link for larger videos.");
    expect(sizeError("mov", 200 * MB + 1)).toBe("MOV files can be up to 200 MB. Paste a link for larger videos.");
    expect(sizeError("gif", 0)).toBe("The file is empty.");
  });
});
