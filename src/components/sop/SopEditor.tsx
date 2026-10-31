"use client";

import { useMemo, useRef, useState } from "react";
import { EditorContent, ReactNodeViewRenderer, useEditor, useEditorState, type Editor } from "@tiptap/react";
import DragHandle from "@tiptap/extension-drag-handle-react";
import { NodeSelection } from "@tiptap/pm/state";
import { buildSopExtensions } from "@/components/sop/sopExtensions";
import { FormulaTableNodeView, ImageNodeView } from "@/components/sop/SopNodeViews";
import { useSopRender } from "@/components/sop/SopRenderContext";
import { HIGHLIGHT_COLORS, TEXT_COLORS, isAllowedLink, type DocNode } from "@/lib/sopDocument";
import "@/components/sop/sopDocument.css";

const btn =
  "inline-flex h-7 min-w-7 items-center justify-center rounded border border-transparent px-1.5 text-xs font-medium text-black hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40";
const btnActive = "border-emerald-500 bg-emerald-50";
const sep = <span className="mx-1 h-5 w-px bg-zinc-300" aria-hidden />;

export type SopEditorHandle = { editor: Editor | null };

export function SopEditor({
  initialContent,
  onChange,
  onBlur,
  onUploadImage,
  editorRef,
}: {
  initialContent: DocNode;
  onChange: (doc: DocNode) => void;
  onBlur: () => void;
  onUploadImage: (file: File) => Promise<{ path: string } | null>;
  editorRef?: React.MutableRefObject<Editor | null>;
}) {
  const ctx = useSopRender();
  const uploadRef = useRef(onUploadImage);
  uploadRef.current = onUploadImage;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const blurRef = useRef(onBlur);
  blurRef.current = onBlur;

  const extensions = useMemo(
    () =>
      buildSopExtensions({
        formulaTableView: ReactNodeViewRenderer(FormulaTableNodeView),
        imageView: ReactNodeViewRenderer(ImageNodeView),
      }),
    [],
  );

  const insertImages = async (ed: Editor, files: File[], pos?: number) => {
    for (const file of files) {
      const res = await uploadRef.current(file);
      if (!res) continue;
      const node = { type: "image", attrs: { path: res.path, alt: file.name.slice(0, 200), title: null, width: null } };
      if (pos !== undefined) ed.chain().insertContentAt(pos, node).run();
      else ed.chain().focus().insertContent(node).run();
    }
  };

  const editor = useEditor({
    extensions,
    content: initialContent,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "ProseMirror", spellcheck: "true" },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (!files.length || !editorInstance.current) return false;
        event.preventDefault();
        insertImages(editorInstance.current, files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (!files.length || !editorInstance.current) return false;
        event.preventDefault();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        insertImages(editorInstance.current, files, coords?.pos);
        return true;
      },
    },
    onUpdate: ({ editor }) => changeRef.current(editor.getJSON() as DocNode),
    onBlur: () => blurRef.current(),
    onSelectionUpdate: ({ editor }) => {
      const sel = editor.state.selection;
      if (sel instanceof NodeSelection && sel.node.type.name === "formulaTable") {
        ctx.setSelectedFormulaNodeId(sel.node.attrs.nodeId as string);
      }
    },
  });
  const editorInstance = useRef<Editor | null>(null);
  editorInstance.current = editor;
  if (editorRef) editorRef.current = editor;

  if (!editor) return <p className="p-4 text-xs text-black">Loading editor…</p>;

  return (
    <div className="rounded-md border border-zinc-200 bg-white">
      <Toolbar editor={editor} onPickImage={(files) => insertImages(editor, files)} />
      <FormulaTableSettings editor={editor} />
      <TableControls editor={editor} />
      <div className="sop-doc relative px-2 py-2 sm:px-6">
        <DragHandle editor={editor} className="sop-no-print">
          <div className="sop-drag-handle" title="Drag to move. Alt+Up / Alt+Down also moves blocks." aria-label="Drag block">
            ⋮⋮
          </div>
        </DragHandle>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({ editor, onPickImage }: { editor: Editor; onPickImage: (files: File[]) => void }) {
  const ctx = useSopRender();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [tableDialog, setTableDialog] = useState(false);
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [withHeader, setWithHeader] = useState(true);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      link: e.isActive("link"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      align: (["left", "center", "right", "justify"] as const).find((a) => e.isActive({ textAlign: a })) ?? "left",
      color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const style = s.h1 ? "h1" : s.h2 ? "h2" : s.h3 ? "h3" : "p";
  const setStyle = (v: string) => {
    const c = editor.chain().focus();
    if (v === "p") c.setParagraph().run();
    else c.setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run();
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setLinkOpen(false);
      return;
    }
    const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    if (!isAllowedLink(full)) {
      setLinkError("Links must start with http, https or mailto.");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: full }).run();
    setLinkOpen(false);
  };

  return (
    <div className="sop-no-print sticky top-0 z-20 flex flex-wrap items-center gap-0.5 border-b border-zinc-200 bg-white p-1.5">
      <button type="button" className={btn} title="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => editor.chain().focus().undo().run()}>↶</button>
      <button type="button" className={btn} title="Redo (Ctrl+Y)" disabled={!s.canRedo} onClick={() => editor.chain().focus().redo().run()}>↷</button>
      {sep}
      <select
        aria-label="Text style"
        value={style}
        onChange={(e) => setStyle(e.target.value)}
        className="h-7 rounded border border-zinc-300 bg-white px-1 text-xs text-black"
      >
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      {sep}
      <button type="button" className={`${btn} font-bold ${s.bold ? btnActive : ""}`} title="Bold (Ctrl+B)" onClick={() => editor.chain().focus().toggleBold().run()}>B</button>
      <button type="button" className={`${btn} italic ${s.italic ? btnActive : ""}`} title="Italic (Ctrl+I)" onClick={() => editor.chain().focus().toggleItalic().run()}>I</button>
      <button type="button" className={`${btn} underline ${s.underline ? btnActive : ""}`} title="Underline (Ctrl+U)" onClick={() => editor.chain().focus().toggleUnderline().run()}>U</button>
      <button type="button" className={`${btn} line-through ${s.strike ? btnActive : ""}`} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}>S</button>
      {sep}
      <span className="mr-1 text-[10px] font-medium text-black">Text</span>
      {TEXT_COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          title={`Text color: ${c.name}`}
          aria-label={`Text color ${c.name}`}
          className={`h-5 w-5 rounded-full border ${(s.color ?? "#000000").toLowerCase() === c.value ? "border-black ring-2 ring-emerald-500" : "border-zinc-300"}`}
          style={{ backgroundColor: c.value }}
          onClick={() => (c.value === "#000000" ? editor.chain().focus().unsetColor().run() : editor.chain().focus().setColor(c.value).run())}
        />
      ))}
      <span className="ml-2 mr-1 text-[10px] font-medium text-black">Highlight</span>
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          title={`Highlight: ${c.name}`}
          aria-label={`Highlight ${c.name}`}
          className="h-5 w-5 rounded border border-zinc-300"
          style={{ backgroundColor: c.value }}
          onClick={() => editor.chain().focus().setHighlight({ color: c.value }).run()}
        />
      ))}
      <button type="button" title="No highlight" aria-label="No highlight" className="h-5 w-5 rounded border border-zinc-300 bg-white text-[10px] text-black" onClick={() => editor.chain().focus().unsetHighlight().run()}>
        ⦸
      </button>
      {sep}
      <button type="button" className={`${btn} ${s.bullet ? btnActive : ""}`} title="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
      <button type="button" className={`${btn} ${s.ordered ? btnActive : ""}`} title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. List</button>
      <button type="button" className={btn} title="Outdent (Shift+Tab)" onClick={() => editor.chain().focus().outdentBlock().run()}>⇤</button>
      <button type="button" className={btn} title="Indent (Tab)" onClick={() => editor.chain().focus().indentBlock().run()}>⇥</button>
      {sep}
      {(["left", "center", "right", "justify"] as const).map((a) => (
        <button
          key={a}
          type="button"
          className={`${btn} ${s.align === a ? btnActive : ""}`}
          title={`Align ${a}`}
          onClick={() => editor.chain().focus().setTextAlign(a).run()}
        >
          {a === "left" ? "⯇≡" : a === "center" ? "≡" : a === "right" ? "≡⯈" : "☰"}
        </button>
      ))}
      {sep}
      <button
        type="button"
        className={`${btn} ${s.link ? btnActive : ""}`}
        title="Link"
        onClick={() => {
          setLinkUrl((editor.getAttributes("link").href as string) ?? "");
          setLinkError(null);
          setLinkOpen((o) => !o);
        }}
      >
        Link
      </button>
      <button type="button" className={btn} title="Horizontal line" onClick={() => editor.chain().focus().setHorizontalRule().run()}>―</button>
      <button type="button" className={btn} title="Page break (for printing)" onClick={() => editor.chain().focus().setPageBreak().run()}>Page break</button>
      <button type="button" className={btn} title="Image (PNG, JPG, WebP up to 10 MB). You can also paste or drag images in." onClick={() => fileRef.current?.click()}>
        Image
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onPickImage(files);
        }}
      />
      {sep}
      <button type="button" className={btn} title="Insert a table you fill in by hand" onClick={() => setTableDialog((o) => !o)}>
        Insert table
      </button>
      <button
        type="button"
        className={`${btn} border-emerald-600 text-emerald-900`}
        title="Insert a formula table generated from a product's current formula"
        onClick={() => editor.chain().focus().insertFormulaTable({ productId: ctx.defaultProductId }).run()}
      >
        Insert formula table
      </button>
      {sep}
      <button type="button" className={btn} title="Move block up (Alt+Up)" onClick={() => editor.chain().focus().moveBlockUp().run()}>↑ Move up</button>
      <button type="button" className={btn} title="Move block down (Alt+Down)" onClick={() => editor.chain().focus().moveBlockDown().run()}>↓ Move down</button>

      {linkOpen && (
        <div className="flex w-full flex-wrap items-center gap-2 border-t border-zinc-200 pt-1.5">
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyLink()}
            placeholder="https://… or mailto:…"
            className="h-7 w-72 rounded border border-zinc-300 px-2 text-xs text-black"
          />
          <button type="button" className={`${btn} border-zinc-300`} onClick={applyLink}>Apply</button>
          <button type="button" className={`${btn} border-zinc-300`} onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); }}>Remove link</button>
          {linkError && <span className="text-xs text-red-600">{linkError}</span>}
        </div>
      )}
      {tableDialog && (
        <div className="flex w-full flex-wrap items-center gap-2 border-t border-zinc-200 pt-1.5 text-xs text-black">
          <label>Rows <input type="number" min={1} max={100} value={rows} onChange={(e) => setRows(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className="ml-1 h-7 w-14 rounded border border-zinc-300 px-1" /></label>
          <label>Columns <input type="number" min={1} max={20} value={cols} onChange={(e) => setCols(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} className="ml-1 h-7 w-14 rounded border border-zinc-300 px-1" /></label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={withHeader} onChange={(e) => setWithHeader(e.target.checked)} /> Header row</label>
          <button
            type="button"
            className={`${btn} border-zinc-300`}
            onClick={() => {
              editor.chain().focus().insertTable({ rows, cols, withHeaderRow: withHeader }).run();
              editor.view.focus(); // focus now, so typing goes straight into the first cell
              setTableDialog(false);
            }}
          >
            Insert
          </button>
        </div>
      )}
    </div>
  );
}

function TableControls({ editor }: { editor: Editor }) {
  const inTable = useEditorState({ editor, selector: ({ editor: e }) => e.isActive("table") });
  if (!inTable) return null;
  const c = () => editor.chain().focus();
  return (
    <div className="sop-no-print flex flex-wrap items-center gap-0.5 border-b border-zinc-200 bg-zinc-50 p-1.5 text-xs text-black">
      <span className="mr-1 font-semibold">Table:</span>
      <button type="button" className={btn} onClick={() => c().addRowBefore().run()}>+ Row above</button>
      <button type="button" className={btn} onClick={() => c().addRowAfter().run()}>+ Row below</button>
      <button type="button" className={btn} onClick={() => c().deleteRow().run()}>− Row</button>
      {sep}
      <button type="button" className={btn} onClick={() => c().addColumnBefore().run()}>+ Column left</button>
      <button type="button" className={btn} onClick={() => c().addColumnAfter().run()}>+ Column right</button>
      <button type="button" className={btn} onClick={() => c().deleteColumn().run()}>− Column</button>
      {sep}
      <button type="button" className={btn} onClick={() => c().toggleHeaderRow().run()}>Header row on/off</button>
      <button type="button" className={btn} onClick={() => c().mergeOrSplit().run()}>Merge/split cells</button>
      {sep}
      <button type="button" className={`${btn} text-red-700`} onClick={() => c().deleteTable().run()}>Delete table</button>
    </div>
  );
}

/** Settings for the selected Formula Table: product and source caption. */
function FormulaTableSettings({ editor }: { editor: Editor }) {
  const ctx = useSopRender();
  const selected = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const sel = e.state.selection;
      if (sel instanceof NodeSelection && sel.node.type.name === "formulaTable") {
        return { pos: sel.from, nodeId: sel.node.attrs.nodeId as string, productId: (sel.node.attrs.productId as string | null) ?? null, showSource: sel.node.attrs.showSource !== false };
      }
      return null;
    },
  });
  if (!selected) return null;

  const update = (attrs: Record<string, unknown>) => {
    editor
      .chain()
      .command(({ tr }) => {
        const node = tr.doc.nodeAt(selected.pos);
        if (!node || node.type.name !== "formulaTable") return false;
        tr.setNodeMarkup(selected.pos, undefined, { ...node.attrs, ...attrs });
        tr.setSelection(NodeSelection.create(tr.doc, selected.pos));
        return true;
      })
      .run();
  };

  const live = selected.productId ? ctx.getLive(selected.productId).data : null;
  const known = selected.productId ? ctx.products.find((p) => p.id === selected.productId) : null;

  return (
    <div className="sop-no-print flex flex-wrap items-center gap-3 border-b border-emerald-200 bg-emerald-50 p-2 text-xs text-black">
      <span className="font-semibold">Formula table settings</span>
      <label className="flex items-center gap-1">
        Product
        <select
          value={selected.productId ?? ""}
          onChange={(e) => update({ productId: e.target.value || null })}
          className="h-7 rounded border border-zinc-300 bg-white px-1 text-xs text-black"
        >
          <option value="">Choose a BotanIQals product…</option>
          {selected.productId && !known && <option value={selected.productId}>(removed product)</option>}
          {ctx.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={selected.showSource} onChange={(e) => update({ showSource: e.target.checked })} />
        Show source caption
      </label>
      {live?.status === "ok" && live.bomDiffers && (
        <span className="rounded border border-amber-400 bg-amber-50 px-2 py-0.5 font-medium text-black">⚠ Products &amp; BOM differs from this formula.</span>
      )}
      <span className="text-black">Columns: 1, 20, 40 … 200 units. Numbers update automatically from the latest finalized formula.</span>
      <button type="button" className={`${btn} ml-auto text-red-700`} onClick={() => editor.chain().focus().deleteSelection().run()}>
        Remove table
      </button>
    </div>
  );
}
