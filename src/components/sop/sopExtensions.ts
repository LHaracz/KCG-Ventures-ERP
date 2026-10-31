/**
 * Tiptap extensions for SOP documents. Schema-level only (no React), so the
 * same set can be used headless in tests. Pass node view renderers from the
 * React editor to get the interactive formula table and signed-URL images.
 *
 * Keep in sync with NODE_RULES / MARK_RULES in src/lib/sopDocument.ts.
 */
import { Extension, Node, mergeAttributes, type AnyExtension, type NodeViewRenderer } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Plugin, PluginKey, TextSelection, NodeSelection } from "@tiptap/pm/state";
import { isAllowedLink, newUuid } from "@/lib/sopDocument";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sopBlocks: {
      moveBlockUp: () => ReturnType;
      moveBlockDown: () => ReturnType;
      indentBlock: () => ReturnType;
      outdentBlock: () => ReturnType;
      setPageBreak: () => ReturnType;
      insertFormulaTable: (attrs: { productId: string | null }) => ReturnType;
    };
  }
}

/** Indent attribute on paragraphs and headings (list items use sink/lift instead). */
const Indent = Extension.create({
  name: "sopIndent",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) => {
              const n = Number(el.getAttribute("data-indent") || 0);
              return Number.isInteger(n) && n >= 0 && n <= 8 ? n : 0;
            },
            renderHTML: (attrs) => (attrs.indent ? { "data-indent": String(attrs.indent) } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    const change = (delta: number) => ({ editor, tr, state, dispatch }: any) => {
      if (editor.isActive("listItem")) {
        return delta > 0 ? editor.commands.sinkListItem("listItem") : editor.commands.liftListItem("listItem");
      }
      const { from, to } = state.selection;
      let changed = false;
      state.doc.nodesBetween(from, to, (node: any, pos: number) => {
        if (node.type.name === "paragraph" || node.type.name === "heading") {
          const next = Math.max(0, Math.min(8, (node.attrs.indent || 0) + delta));
          if (next !== node.attrs.indent) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
            changed = true;
          }
          return false;
        }
        return true;
      });
      if (changed && dispatch) dispatch(tr);
      return changed;
    };
    return {
      indentBlock: () => change(1),
      outdentBlock: () => change(-1),
    } as any;
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => (this.editor.isActive("table") ? false : this.editor.commands.indentBlock()),
      "Shift-Tab": () => (this.editor.isActive("table") ? false : this.editor.commands.outdentBlock()),
    };
  },
});

/** Move the top-level block containing the selection up or down (Alt+Up / Alt+Down). */
const MoveBlock = Extension.create({
  name: "sopMoveBlock",
  addCommands() {
    const move = (dir: -1 | 1) => ({ state, dispatch }: any) => {
      const { selection, doc } = state;
      const $pos = selection instanceof NodeSelection && selection.$from.depth === 0 ? doc.resolve(selection.from + 1) : selection.$from;
      if ($pos.depth < 1 && !(selection instanceof NodeSelection)) return false;
      const index = selection instanceof NodeSelection && selection.$from.depth === 0 ? selection.$from.index(0) : $pos.index(0);
      const target = index + dir;
      if (target < 0 || target >= doc.childCount) return false;
      if (!dispatch) return true;
      const node = doc.child(index);
      const other = doc.child(target);
      let start = 0;
      for (let i = 0; i < Math.min(index, target); i++) start += doc.child(i).nodeSize;
      const first = dir === -1 ? node : other;
      const second = dir === -1 ? other : node;
      const end = start + node.nodeSize + other.nodeSize;
      const tr = state.tr.replaceWith(start, end, [first, second]);
      const newStart = dir === -1 ? start : start + other.nodeSize;
      if (selection instanceof NodeSelection) {
        tr.setSelection(NodeSelection.create(tr.doc, newStart));
      } else {
        const offset = selection.from - (start + (dir === -1 ? other.nodeSize : 0));
        const pos = Math.min(Math.max(newStart + offset, newStart + 1), newStart + node.nodeSize - 1);
        try {
          tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
        } catch {
          /* keep default mapping */
        }
      }
      dispatch(tr.scrollIntoView());
      return true;
    };
    return { moveBlockUp: () => move(-1), moveBlockDown: () => move(1) } as any;
  },
  addKeyboardShortcuts() {
    return {
      "Alt-ArrowUp": () => this.editor.commands.moveBlockUp(),
      "Alt-ArrowDown": () => this.editor.commands.moveBlockDown(),
    };
  },
});

export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML: () => [{ tag: "div[data-page-break]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-page-break": "", class: "sop-page-break" })],
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ commands }: any) =>
          commands.insertContent({ type: "pageBreak" }),
    } as any;
  },
});

export function createFormulaTableNode(nodeView?: NodeViewRenderer) {
  return Node.create({
    name: "formulaTable",
    group: "block",
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes() {
      return {
        nodeId: { default: null, parseHTML: (el) => el.getAttribute("data-node-id"), renderHTML: (a) => ({ "data-node-id": a.nodeId }) },
        productId: {
          default: null,
          parseHTML: (el) => el.getAttribute("data-product-id") || null,
          renderHTML: (a) => (a.productId ? { "data-product-id": a.productId } : {}),
        },
        showSource: {
          default: true,
          parseHTML: (el) => el.getAttribute("data-show-source") !== "false",
          renderHTML: (a) => ({ "data-show-source": a.showSource ? "true" : "false" }),
        },
      };
    },
    parseHTML: () => [{ tag: "div[data-formula-table]" }],
    renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-formula-table": "" }), "Formula table"],
    addNodeView() {
      return nodeView ?? null;
    },
    addCommands() {
      return {
        insertFormulaTable:
          ({ productId }: { productId: string | null }) =>
          ({ commands }: any) =>
            commands.insertContent({ type: "formulaTable", attrs: { nodeId: newUuid(), productId, showSource: true } }),
      } as any;
    },
    addProseMirrorPlugins() {
      // Every formula table needs a unique, stable nodeId. Copy/paste of a
      // table duplicates the id, so later duplicates get a fresh one.
      return [
        new Plugin({
          key: new PluginKey("formulaTableIds"),
          appendTransaction: (trs, _old, state) => {
            if (!trs.some((t) => t.docChanged)) return null;
            const seen = new Set<string>();
            const fixes: { pos: number; attrs: Record<string, unknown> }[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "formulaTable") return true;
              const id = node.attrs.nodeId as string | null;
              if (!id || seen.has(id)) fixes.push({ pos, attrs: { ...node.attrs, nodeId: newUuid() } });
              else seen.add(id);
              return false;
            });
            if (!fixes.length) return null;
            const tr = state.tr;
            for (const f of fixes) tr.setNodeMarkup(f.pos, undefined, f.attrs);
            return tr;
          },
        }),
      ];
    },
  });
}

/** Image stored by private-bucket path. No src is ever stored. */
export function createSopImageNode(nodeView?: NodeViewRenderer) {
  return Node.create({
    name: "image",
    group: "block",
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes() {
      return {
        path: { default: null, parseHTML: (el) => el.getAttribute("data-sop-path"), renderHTML: (a) => ({ "data-sop-path": a.path }) },
        alt: { default: null },
        title: { default: null },
        width: {
          default: null,
          parseHTML: (el) => {
            const n = Number(el.getAttribute("data-width"));
            return Number.isInteger(n) && n >= 16 && n <= 2000 ? n : null;
          },
          renderHTML: (a) => (a.width ? { "data-width": String(a.width) } : {}),
        },
      };
    },
    // Only images uploaded to the SOP bucket are accepted; pasted external <img> are dropped.
    parseHTML: () => [{ tag: "img[data-sop-path]" }],
    renderHTML: ({ HTMLAttributes }) => ["img", mergeAttributes(HTMLAttributes)],
    addNodeView() {
      return nodeView ?? null;
    },
  });
}

export function buildSopExtensions(opts: { formulaTableView?: NodeViewRenderer; imageView?: NodeViewRenderer; placeholder?: string } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      heading: { levels: [1, 2, 3] },
      dropcursor: { color: "#10b981", width: 2 },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto"],
        isAllowedUri: (url: string) => isAllowedLink(url),
      },
    }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Indent,
    MoveBlock,
    Table.configure({ resizable: true, allowTableNodeSelection: true }),
    TableRow,
    TableHeader,
    TableCell,
    PageBreak,
    createFormulaTableNode(opts.formulaTableView),
    createSopImageNode(opts.imageView),
  ];
}
