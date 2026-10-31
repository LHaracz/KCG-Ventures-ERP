/**
 * SOP document format (Tiptap / ProseMirror JSON): server-side validation,
 * search-text extraction, formula-table discovery and starter templates.
 * Pure — safe to import from API routes, scripts, tests and the browser.
 */

export type DocNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
};

export const MAX_DOC_BYTES = 2 * 1024 * 1024;

export const TEXT_COLORS = [
  { name: "Black", value: "#000000" },
  { name: "Red", value: "#dc2626" },
  { name: "Orange", value: "#ea580c" },
  { name: "Green", value: "#15803d" },
  { name: "Blue", value: "#1d4ed8" },
  { name: "Purple", value: "#7e22ce" },
] as const;

export const HIGHLIGHT_COLORS = [
  { name: "Yellow", value: "#fef08a" },
  { name: "Green", value: "#bbf7d0" },
  { name: "Pink", value: "#fbcfe8" },
  { name: "Blue", value: "#bfdbfe" },
] as const;

const ALIGN = new Set(["left", "center", "right", "justify", null]);
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AttrRule = (v: unknown) => boolean;
const isNullOr = (rule: AttrRule): AttrRule => (v) => v === null || v === undefined || rule(v);
const isInt = (min: number, max: number): AttrRule => (v) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isStr = (max = 2000): AttrRule => (v) => typeof v === "string" && v.length <= max;
const isBool: AttrRule = (v) => typeof v === "boolean";
const isAlign: AttrRule = (v) => ALIGN.has((v ?? null) as string | null);
const isUuid: AttrRule = (v) => typeof v === "string" && UUID_RE.test(v);
const isColor: AttrRule = (v) => typeof v === "string" && COLOR_RE.test(v.trim());
const isColWidth: AttrRule = (v) => v === null || (Array.isArray(v) && v.every((n) => n === null || (typeof n === "number" && n > 0 && n < 5000)));

const BLOCK_ATTRS = { textAlign: isAlign, indent: isNullOr(isInt(0, 8)) };

/** Allowed node types -> allowed attributes. Anything else is rejected. */
const NODE_RULES: Record<string, Record<string, AttrRule>> = {
  doc: {},
  paragraph: BLOCK_ATTRS,
  heading: { ...BLOCK_ATTRS, level: isInt(1, 3) },
  text: {},
  hardBreak: {},
  bulletList: {},
  orderedList: { start: isNullOr(isInt(0, 100000)), type: isNullOr(isStr(10)) },
  listItem: {},
  blockquote: {},
  horizontalRule: {},
  pageBreak: {},
  table: {},
  tableRow: {},
  tableHeader: { colspan: isInt(1, 50), rowspan: isInt(1, 500), colwidth: isColWidth, align: isAlign },
  tableCell: { colspan: isInt(1, 50), rowspan: isInt(1, 500), colwidth: isColWidth, align: isAlign },
  image: {
    path: isStr(500),
    alt: isNullOr(isStr(500)),
    title: isNullOr(isStr(500)),
    width: isNullOr(isInt(16, 2000)),
  },
  formulaTable: { nodeId: isUuid, productId: isNullOr(isUuid), showSource: isBool },
};

const MARK_RULES: Record<string, Record<string, AttrRule>> = {
  bold: {},
  italic: {},
  underline: {},
  strike: {},
  textStyle: { color: isNullOr(isColor) },
  highlight: { color: isNullOr(isColor) },
  link: {
    href: (v) => typeof v === "string" && isAllowedLink(v),
    target: isNullOr(isStr(20)),
    rel: isNullOr(isStr(100)),
    class: isNullOr(isStr(100)),
    title: isNullOr(isStr(500)),
  },
};

export const ALLOWED_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];

export function isAllowedLink(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || /[\u0000-\u001f]/.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return ALLOWED_LINK_PROTOCOLS.includes(url.protocol);
  } catch {
    return false; // relative or malformed links are not allowed
  }
}

export type ValidationResult = { ok: true; doc: DocNode } | { ok: false; error: string };

/** Validates a document against the editor schema. Never mutates the input. */
export function validateSopDocument(input: unknown): ValidationResult {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return { ok: false, error: "Document is not valid JSON." };
  }
  if (!json) return { ok: false, error: "Document is empty." };
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_DOC_BYTES) return { ok: false, error: "Document is larger than the 2 MB limit." };

  const doc = input as DocNode;
  if (!doc || typeof doc !== "object" || doc.type !== "doc") return { ok: false, error: "Document root must be a doc node." };

  const nodeIds = new Set<string>();
  let nodeCount = 0;
  const visit = (node: DocNode, path: string, depth: number): string | null => {
    if (depth > 60) return `${path}: document is nested too deeply.`;
    if (++nodeCount > 200000) return "Document has too many nodes.";
    if (!node || typeof node !== "object" || typeof node.type !== "string") return `${path}: invalid node.`;
    const rules = NODE_RULES[node.type];
    if (!rules) return `${path}: node type "${node.type}" is not allowed.`;
    for (const key of Object.keys(node)) {
      if (!["type", "attrs", "content", "marks", "text"].includes(key)) return `${path}: unexpected property "${key}".`;
    }
    if (node.attrs !== undefined) {
      if (typeof node.attrs !== "object" || node.attrs === null || Array.isArray(node.attrs)) return `${path}: attrs must be an object.`;
      for (const [k, v] of Object.entries(node.attrs)) {
        const rule = rules[k];
        if (!rule) return `${path}: attribute "${k}" is not allowed on ${node.type}.`;
        if (!rule(v)) return `${path}: invalid value for ${node.type}.${k}.`;
      }
    }
    if (node.type === "text") {
      if (typeof node.text !== "string" || node.text.length === 0) return `${path}: text node needs text.`;
      if (node.content) return `${path}: text node cannot have content.`;
    } else if (node.text !== undefined) {
      return `${path}: only text nodes may carry text.`;
    }
    if (node.type === "image" && (typeof node.attrs?.path !== "string" || !node.attrs.path)) {
      return `${path}: image must reference an uploaded file.`;
    }
    if (node.type === "formulaTable") {
      const id = node.attrs?.nodeId;
      if (typeof id !== "string" || !UUID_RE.test(id)) return `${path}: formula table needs a nodeId.`;
      if (nodeIds.has(id)) return `${path}: duplicate formula table nodeId.`;
      nodeIds.add(id);
    }
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) return `${path}: marks must be an array.`;
      for (const mark of node.marks) {
        const mrules = mark && typeof mark.type === "string" ? MARK_RULES[mark.type] : undefined;
        if (!mrules) return `${path}: mark "${mark?.type}" is not allowed.`;
        for (const key of Object.keys(mark)) {
          if (key !== "type" && key !== "attrs") return `${path}: unexpected mark property "${key}".`;
        }
        for (const [k, v] of Object.entries(mark.attrs ?? {})) {
          const rule = mrules[k];
          if (!rule) return `${path}: mark attribute "${k}" is not allowed on ${mark.type}.`;
          if (!rule(v)) {
            return mark.type === "link" && k === "href"
              ? `${path}: links must use http, https or mailto.`
              : `${path}: invalid value for ${mark.type}.${k}.`;
          }
        }
        if (mark.type === "link" && typeof mark.attrs?.href !== "string") return `${path}: link needs an href.`;
      }
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return `${path}: content must be an array.`;
      for (let i = 0; i < node.content.length; i++) {
        const err = visit(node.content[i], `${path}.${node.type}[${i}]`, depth + 1);
        if (err) return err;
      }
    }
    return null;
  };
  const err = visit(doc, "doc", 0);
  return err ? { ok: false, error: err } : { ok: true, doc };
}

export type FormulaTableRef = { nodeId: string; productId: string | null; showSource: boolean };

/** Every formula table in document order. */
export function findFormulaTables(doc: DocNode | null | undefined): FormulaTableRef[] {
  const out: FormulaTableRef[] = [];
  const walk = (n: DocNode) => {
    if (n.type === "formulaTable") {
      out.push({
        nodeId: String(n.attrs?.nodeId ?? ""),
        productId: (n.attrs?.productId as string | null | undefined) ?? null,
        showSource: n.attrs?.showSource !== false,
      });
    }
    n.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return out;
}

/** Plain text for library search: every text node, block-separated. */
export function extractSearchText(doc: DocNode | null | undefined, maxLength = 200000): string {
  if (!doc) return "";
  const parts: string[] = [];
  const BLOCKS = new Set(["paragraph", "heading", "listItem", "tableCell", "tableHeader", "blockquote"]);
  const walk = (n: DocNode) => {
    if (n.type === "text" && n.text) parts.push(n.text);
    else if (n.type === "hardBreak") parts.push(" ");
    n.content?.forEach(walk);
    if (BLOCKS.has(n.type)) parts.push("\n");
  };
  walk(doc);
  return parts.join("").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim().slice(0, maxLength);
}

/** Every image bucket path referenced by the document. */
export function findImagePaths(doc: DocNode | null | undefined): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (n.type === "image" && typeof n.attrs?.path === "string") out.push(n.attrs.path);
    n.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return out;
}

export function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // RFC4122 v4 fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const p = (text?: string, extra?: Partial<DocNode>): DocNode =>
  text ? { type: "paragraph", content: [{ type: "text", text }], ...extra } : { type: "paragraph", ...extra };
const h = (level: 1 | 2 | 3, text: string): DocNode => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });

export function blankDocument(): DocNode {
  return { type: "doc", content: [p()] };
}

/** "Production SOP template". The formula table uses the SOP's linked product. */
export function productionTemplate(title: string, productId: string | null): DocNode {
  const step = (text: string): DocNode => ({ type: "listItem", content: [p(text)] });
  return {
    type: "doc",
    content: [
      h(1, title || "Title"),
      h(2, "Purpose"),
      p("Describe why this procedure exists."),
      h(2, "Scope"),
      p("Describe what and who this procedure covers."),
      h(2, "Formula"),
      p("Ingredient amounts for the batch size being made, generated from the current formula."),
      { type: "formulaTable", attrs: { nodeId: newUuid(), productId, showSource: true } },
      h(2, "Equipment"),
      { type: "bulletList", content: [{ type: "listItem", content: [p("Equipment item")] }] },
      h(2, "Procedure"),
      { type: "orderedList", attrs: { start: 1 }, content: [step("First step"), step("Second step"), step("Third step")] },
      h(2, "Troubleshooting"),
      p("Common problems and how to fix them."),
    ],
  };
}

/** Exact deep copy (auto-versioning copies the published content unchanged). */
export function cloneDocument(doc: DocNode): DocNode {
  return JSON.parse(JSON.stringify(doc)) as DocNode;
}
