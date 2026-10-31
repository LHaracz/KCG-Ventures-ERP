"use client";

import { useEffect, type CSSProperties, type ReactNode } from "react";
import type { DocNode } from "@/lib/sopDocument";
import { isAllowedLink } from "@/lib/sopDocument";
import { FormulaTableBlock } from "@/components/sop/FormulaTableView";
import { useSopRender } from "@/components/sop/SopRenderContext";

/**
 * Read-only rendering of a published SOP document. Uses the same schema,
 * styles (.sop-doc) and formula table component as the editor, but emits
 * plain DOM so print layout (repeating table headers, page breaks) is exact.
 * Formula tables render from the version's frozen snapshot.
 */
export function SopDocumentRenderer({ doc }: { doc: DocNode }) {
  return <div className="sop-doc sop-doc-readonly">{renderChildren(doc.content)}</div>;
}

function renderChildren(content: DocNode[] | undefined): ReactNode[] {
  return (content ?? []).map((n, i) => <RenderNode key={i} node={n} />);
}

function blockStyle(attrs: Record<string, unknown> | undefined): { style?: CSSProperties; "data-indent"?: string } {
  const out: { style?: CSSProperties; "data-indent"?: string } = {};
  const align = attrs?.textAlign as string | null | undefined;
  if (align && ["left", "center", "right", "justify"].includes(align)) out.style = { textAlign: align as CSSProperties["textAlign"] };
  const indent = Number(attrs?.indent ?? 0);
  if (indent > 0) out["data-indent"] = String(indent);
  return out;
}

function renderText(node: DocNode): ReactNode {
  let el: ReactNode = node.text ?? "";
  for (const mark of node.marks ?? []) {
    const a = mark.attrs ?? {};
    switch (mark.type) {
      case "bold":
        el = <strong>{el}</strong>;
        break;
      case "italic":
        el = <em>{el}</em>;
        break;
      case "underline":
        el = <u>{el}</u>;
        break;
      case "strike":
        el = <s>{el}</s>;
        break;
      case "textStyle":
        if (typeof a.color === "string") el = <span style={{ color: a.color }}>{el}</span>;
        break;
      case "highlight":
        el = <mark style={{ backgroundColor: typeof a.color === "string" ? a.color : "#fef08a" }}>{el}</mark>;
        break;
      case "link":
        if (typeof a.href === "string" && isAllowedLink(a.href)) {
          el = (
            <a href={a.href} target="_blank" rel="noopener noreferrer nofollow">
              {el}
            </a>
          );
        }
        break;
    }
  }
  return el;
}

function SopImage({ path, alt, width }: { path: string; alt: string; width: number | null }) {
  const ctx = useSopRender();
  useEffect(() => {
    ctx.requestImage(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const url = ctx.imageUrl(path);
  if (!url) return <div className="my-2 h-24 w-full max-w-sm rounded border border-dashed border-zinc-300 text-center text-xs leading-[6rem] text-black">Loading image…</div>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} style={width ? { width } : undefined} />;
}

function RenderTable({ node }: { node: DocNode }) {
  const rows = node.content ?? [];
  const first = rows[0];
  const headerFirst = !!first?.content?.length && first.content.every((c) => c.type === "tableHeader");
  const cell = (c: DocNode, j: number) => {
    const Tag = c.type === "tableHeader" ? "th" : "td";
    const colspan = Number(c.attrs?.colspan ?? 1);
    const rowspan = Number(c.attrs?.rowspan ?? 1);
    const widths = c.attrs?.colwidth as number[] | null | undefined;
    const width = widths?.length ? widths.reduce((s, w) => s + (w || 0), 0) : undefined;
    return (
      <Tag key={j} colSpan={colspan > 1 ? colspan : undefined} rowSpan={rowspan > 1 ? rowspan : undefined} style={width ? { width } : undefined}>
        {renderChildren(c.content)}
      </Tag>
    );
  };
  const body = headerFirst ? rows.slice(1) : rows;
  return (
    <div className="sop-table-wrap">
      <table className="sop-manual-table">
        {headerFirst && (
          <thead>
            <tr>{first.content!.map(cell)}</tr>
          </thead>
        )}
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{(r.content ?? []).map(cell)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RenderNode({ node }: { node: DocNode }): ReactNode {
  const a = node.attrs ?? {};
  switch (node.type) {
    case "text":
      return renderText(node);
    case "paragraph":
      return <p {...blockStyle(a)}>{renderChildren(node.content)}</p>;
    case "heading": {
      const level = Number(a.level) === 1 ? 1 : Number(a.level) === 2 ? 2 : 3;
      const H = (`h${level}` as "h1" | "h2" | "h3");
      return <H {...blockStyle(a)}>{renderChildren(node.content)}</H>;
    }
    case "hardBreak":
      return <br />;
    case "bulletList":
      return <ul>{renderChildren(node.content)}</ul>;
    case "orderedList":
      return <ol start={typeof a.start === "number" ? a.start : undefined}>{renderChildren(node.content)}</ol>;
    case "listItem":
      return <li>{renderChildren(node.content)}</li>;
    case "blockquote":
      return <blockquote>{renderChildren(node.content)}</blockquote>;
    case "horizontalRule":
      return <hr />;
    case "pageBreak":
      return <div className="sop-page-break" data-page-break="" />;
    case "table":
      return <RenderTable node={node} />;
    case "image":
      return typeof a.path === "string" ? (
        <SopImage path={a.path} alt={typeof a.alt === "string" ? a.alt : ""} width={typeof a.width === "number" ? a.width : null} />
      ) : null;
    case "formulaTable":
      return (
        <div className="sop-formula">
          <FormulaTableBlock nodeId={String(a.nodeId ?? "")} productId={(a.productId as string | null) ?? null} showSource={a.showSource !== false} />
        </div>
      );
    default:
      return null;
  }
}
