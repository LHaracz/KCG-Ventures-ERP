// Asset name helpers (invented names only).
import { describe, expect, it } from "vitest";
import { applyNamePattern, assetExtension, assetNameError, hasDuplicateName, safeDownloadName, titleFromFileName } from "@/lib/growth/assetNames";

describe("titleFromFileName", () => {
  it("strips only the last extension and keeps the rest as is", () => {
    expect(titleFromFileName("IMG_4821.JPG")).toBe("IMG_4821");
    expect(titleFromFileName("a.b.png")).toBe("a.b");
    expect(titleFromFileName("Gum_flat-lay 2.webp")).toBe("Gum_flat-lay 2");
  });
  it("leaves names without an extension and hidden files alone, and trims", () => {
    expect(titleFromFileName("notes")).toBe("notes");
    expect(titleFromFileName(".hidden")).toBe(".hidden");
    expect(titleFromFileName("  Photo A .png ")).toBe("Photo A");
  });
});

describe("assetNameError", () => {
  it("requires 1 to 200 characters after trimming", () => {
    expect(assetNameError("   ")).toBe("Enter a name.");
    expect(assetNameError("x".repeat(201))).toMatch(/200/);
    expect(assetNameError(` ${"x".repeat(200)} `)).toBeNull();
  });
});

describe("applyNamePattern", () => {
  it("replaces {n} in order", () => {
    expect(applyNamePattern("Gum flat lay {n}", 3)).toEqual(["Gum flat lay 1", "Gum flat lay 2", "Gum flat lay 3"]);
    expect(applyNamePattern("{n}. Shot {n}", 2)).toEqual(["1. Shot 1", "2. Shot 2"]);
  });
  it("adds a space and the number without {n}", () => {
    expect(applyNamePattern(" Product A ", 2)).toEqual(["Product A 1", "Product A 2"]);
  });
  it("returns nothing for zero rows", () => {
    expect(applyNamePattern("Photo {n}", 0)).toEqual([]);
  });
});

describe("safeDownloadName", () => {
  it("removes characters unsafe in file names and keeps the extension", () => {
    expect(safeDownloadName('Photo: A/B "final"?', "jpg")).toBe("Photo AB final.jpg");
    expect(safeDownloadName("  ", "png")).toBe("asset.png");
    expect(safeDownloadName("Flyer.", "pdf")).toBe("Flyer.pdf");
  });
  it("cuts long names at 120 characters", () => {
    const n = safeDownloadName("y".repeat(300), "png");
    expect(n).toBe(`${"y".repeat(120)}.png`);
  });
  it("takes the extension from the stored path, else the MIME type", () => {
    expect(assetExtension("assets/2026-11/abc.webp", "image/png")).toBe("webp");
    expect(assetExtension(null, "application/pdf")).toBe("pdf");
    expect(assetExtension(null, null)).toBe("bin");
  });
});

describe("hasDuplicateName", () => {
  const assets = [
    { id: "1", title: "Photo A", status: "ready" },
    { id: "2", title: "Photo B", status: "archived" },
  ];
  it("matches other non-archived assets, ignoring case", () => {
    expect(hasDuplicateName(assets, " photo a ")).toBe(true);
    expect(hasDuplicateName(assets, "Photo A", "1")).toBe(false);
    expect(hasDuplicateName(assets, "Photo B")).toBe(false);
  });
});
