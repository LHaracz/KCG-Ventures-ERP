// @vitest-environment jsdom
// Invented content only.
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildSopExtensions } from "@/components/sop/sopExtensions";
import {
  MAX_DOC_BYTES,
  extractSearchText,
  findFormulaTables,
  isAllowedLink,
  productionTemplate,
  validateSopDocument,
  type DocNode,
} from "@/lib/sopDocument";

const PRODUCT = "11111111-1111-4111-8111-111111111111";

function editorWith(content: string | DocNode) {
  return new Editor({ extensions: buildSopExtensions(), content });
}

describe("editor schema and server validation agree", () => {
  it("accepts everything the toolbar can produce", () => {
    const html = `
      <h1 style="text-align:center">Title ✅🧪</h1>
      <h2>Section</h2><h3>Sub</h3>
      <p data-indent="2"><strong>b</strong> <em>i</em> <u>u</u> <s>s</s>
        <span style="color:#dc2626">red</span> <mark data-color="#fef08a" style="background-color:#fef08a">hl</mark>
        <a href="https://example.com">link</a> <a href="mailto:a@example.com">mail</a></p>
      <ul><li><p>one</p><ul><li><p>nested</p></li></ul></li></ul>
      <ol start="3"><li><p>three</p></li></ol>
      <hr>
      <div data-page-break></div>
      <table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr></table>
      <img data-sop-path="sop/abc.png" alt="x">
      <div data-formula-table data-node-id="22222222-2222-4222-8222-222222222222" data-product-id="${PRODUCT}" data-show-source="true"></div>
    `;
    const ed = editorWith(html);
    const json = ed.getJSON() as DocNode;
    const r = validateSopDocument(json);
    expect(r).toEqual({ ok: true, doc: json });
    const types = new Set<string>();
    const walk = (n: DocNode) => {
      types.add(n.type);
      n.content?.forEach(walk);
    };
    walk(json);
    for (const t of ["heading", "bulletList", "orderedList", "horizontalRule", "pageBreak", "table", "tableHeader", "tableCell", "image", "formulaTable"]) {
      expect(types.has(t)).toBe(true);
    }
    expect(JSON.stringify(json)).not.toContain('"src"');
    ed.destroy();
  });

  it("accepts the production template and finds its formula table", () => {
    const doc = productionTemplate("Test SOP", PRODUCT);
    expect(validateSopDocument(doc).ok).toBe(true);
    const ed = editorWith(doc);
    expect(validateSopDocument(ed.getJSON()).ok).toBe(true);
    expect(findFormulaTables(doc)).toHaveLength(1);
    expect(findFormulaTables(doc)[0].productId).toBe(PRODUCT);
    ed.destroy();
  });

  it("drops external images and javascript links on paste", () => {
    const ed = editorWith(`<p><a href="javascript:alert(1)">bad</a></p><img src="https://example.com/x.png">`);
    const json = JSON.stringify(ed.getJSON());
    expect(json).not.toContain("javascript:");
    expect(json).not.toContain("example.com/x.png");
    ed.destroy();
  });

  it("gives duplicated formula tables a fresh nodeId", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const ed = editorWith({ type: "doc", content: [{ type: "paragraph" }] });
    const node = { type: "formulaTable", attrs: { nodeId: id, productId: PRODUCT, showSource: true } };
    ed.commands.insertContent([node, node]);
    const tables = findFormulaTables(ed.getJSON() as DocNode);
    expect(tables).toHaveLength(2);
    expect(new Set(tables.map((t) => t.nodeId)).size).toBe(2);
    expect(validateSopDocument(ed.getJSON()).ok).toBe(true);
    ed.destroy();
  });

  it("moves a block above the one before it (Alt+Up command)", () => {
    const ed = editorWith(`<p>First</p><p>Second</p><div data-formula-table data-node-id="44444444-4444-4444-8444-444444444444"></div>`);
    // select the formula table (last block) and move it to the top
    let pos = 0;
    ed.state.doc.forEach((n, offset) => {
      if (n.type.name === "formulaTable") pos = offset;
    });
    ed.commands.setNodeSelection(pos);
    ed.commands.moveBlockUp();
    ed.commands.moveBlockUp();
    // (a trailing empty paragraph is always kept at the end by the editor)
    expect((ed.getJSON().content ?? []).map((n) => n.type).slice(0, 3)).toEqual(["formulaTable", "paragraph", "paragraph"]);
    ed.commands.moveBlockDown();
    expect((ed.getJSON().content ?? []).map((n) => n.type).slice(0, 3)).toEqual(["paragraph", "formulaTable", "paragraph"]);
    ed.destroy();
  });
});

describe("validateSopDocument rejects bad content", () => {
  const ok = (content: DocNode[]) => validateSopDocument({ type: "doc", content });
  it("unknown node types", () => {
    expect(ok([{ type: "codeBlock", content: [{ type: "text", text: "x" }] }]).ok).toBe(false);
    expect(ok([{ type: "iframe" }]).ok).toBe(false);
  });
  it("unknown attributes and marks", () => {
    expect(ok([{ type: "paragraph", attrs: { onclick: "x" } }]).ok).toBe(false);
    expect(ok([{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "script" }] }] }]).ok).toBe(false);
    expect(ok([{ type: "image", attrs: { path: "a/b.png", src: "https://x" } }]).ok).toBe(false);
  });
  it("link protocols other than http, https and mailto", () => {
    const link = (href: string) => ok([{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] }] }]);
    expect(link("https://example.com").ok).toBe(true);
    expect(link("http://example.com").ok).toBe(true);
    expect(link("mailto:someone@example.com").ok).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "vbscript:x", "/relative", "JaVaScRiPt:alert(1)", "ftp://x"]) {
      expect(link(bad).ok).toBe(false);
      expect(isAllowedLink(bad)).toBe(false);
    }
  });
  it("bad colors, missing nodeId and duplicate nodeIds", () => {
    expect(ok([{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "textStyle", attrs: { color: "red;background:url(x)" } }] }] }]).ok).toBe(false);
    expect(ok([{ type: "formulaTable", attrs: { nodeId: "nope", productId: null, showSource: true } }]).ok).toBe(false);
    const id = "55555555-5555-4555-8555-555555555555";
    const ft = { type: "formulaTable", attrs: { nodeId: id, productId: null, showSource: true } };
    expect(ok([ft, ft]).ok).toBe(false);
  });
  it("documents over 2 MB", () => {
    const big = "x".repeat(MAX_DOC_BYTES);
    expect(ok([{ type: "paragraph", content: [{ type: "text", text: big }] }]).ok).toBe(false);
  });
  it("non-doc roots", () => {
    expect(validateSopDocument({ type: "paragraph" }).ok).toBe(false);
    expect(validateSopDocument(null).ok).toBe(false);
  });
});

describe("search text", () => {
  it("extracts headings, paragraphs and table cells", () => {
    const text = extractSearchText({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Alpha" }] },
        { type: "paragraph", content: [{ type: "text", text: "Beta" }] },
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Gamma" }] }] }] }] },
      ],
    });
    expect(text).toBe("Alpha\nBeta\nGamma");
  });
});
