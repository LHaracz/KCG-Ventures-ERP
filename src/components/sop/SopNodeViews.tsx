"use client";

import { useEffect } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { FormulaTableBlock } from "@/components/sop/FormulaTableView";
import { useSopRender } from "@/components/sop/SopRenderContext";

/** Editor view of the Formula Table block: live numbers, click to open its settings. */
export function FormulaTableNodeView({ node, selected }: ReactNodeViewProps) {
  const ctx = useSopRender();
  const nodeId = node.attrs.nodeId as string | null;
  useEffect(() => {
    if (selected && nodeId) ctx.setSelectedFormulaNodeId(nodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, nodeId]);
  return (
    <NodeViewWrapper
      className={`sop-formula sop-formula-node ${selected ? "sop-node-selected" : ""}`}
      data-formula-table=""
      data-drag-handle=""
      contentEditable={false}
      onMouseDown={() => nodeId && ctx.setSelectedFormulaNodeId(nodeId)}
    >
      <FormulaTableBlock nodeId={nodeId ?? ""} productId={(node.attrs.productId as string | null) ?? null} showSource={node.attrs.showSource !== false} />
    </NodeViewWrapper>
  );
}

/** Editor view of an image: resolves a short-lived signed URL for the stored bucket path. */
export function ImageNodeView({ node, selected }: ReactNodeViewProps) {
  const ctx = useSopRender();
  const path = node.attrs.path as string | null;
  useEffect(() => {
    if (path) ctx.requestImage(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const url = path ? ctx.imageUrl(path) : null;
  const width = typeof node.attrs.width === "number" ? node.attrs.width : undefined;
  return (
    <NodeViewWrapper contentEditable={false} className={selected ? "outline outline-2 outline-emerald-500" : ""} data-drag-handle="">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={(node.attrs.alt as string) ?? ""} style={width ? { width } : undefined} draggable={false} />
      ) : (
        <div className="my-2 h-24 w-full max-w-sm rounded border border-dashed border-zinc-300 text-center text-xs leading-[6rem] text-black">
          Loading image…
        </div>
      )}
    </NodeViewWrapper>
  );
}
