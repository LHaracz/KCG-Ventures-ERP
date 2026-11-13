"use client";

/**
 * Procurement UI pieces: stock badges, payment chips, the Order button, the
 * Procurement table with its expanded supplier rows, and the Supplier info
 * box shown above a prefilled Purchase Order. Presentational only (props in,
 * callbacks out). Names and notes are rendered as plain text (React escapes
 * them), never as HTML. All text is black; dates are America/New_York.
 */
import { Fragment, Suspense, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { formatNyDate } from "@/lib/nyTime";
import { formatQuantity, type StockAlert } from "@/lib/procurement/stockAlert";
import { formatPrice } from "@/lib/procurement/price";
import { coaPolicyLabel, paymentMethodLabel, procurementHref, type ProcurementTab, type Supplier } from "@/lib/procurement/types";
import {
  createPoBlocker,
  equipmentCreatePoBlocker,
  orderTarget,
  type EquipmentLinkWithSupplier,
  type EquipmentRow,
  type LinkWithSupplier,
  type MaterialRow,
} from "@/lib/procurement/view";
import type { SupplierInfo } from "@/lib/procurement/poPrefill";

export const btn =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-black shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";
export const btnPrimary =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50";
export const btnDanger =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";
export const linkBtn = "text-xs font-medium text-emerald-800 underline hover:text-emerald-900";

const badgeBase = "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium text-black ring-1";

export function StockBadge({ alert }: { alert: StockAlert }) {
  const cls =
    alert.state === "out"
      ? "bg-red-200 ring-red-500"
      : alert.state === "below"
        ? "bg-orange-200 ring-orange-500"
        : alert.state === "ok"
          ? "bg-white ring-zinc-300"
          : "bg-zinc-100 ring-zinc-300";
  return (
    <span className={`${badgeBase} ${cls}`} data-testid="stock-badge" data-state={alert.state}>
      {alert.label}
    </span>
  );
}

export function NoSupplierBadge() {
  return <span className={`${badgeBase} bg-amber-100 ring-amber-400`}>No supplier yet</span>;
}

export function PaymentChips({ methods }: { methods: readonly string[] | null | undefined }) {
  if (!methods || methods.length === 0) return <span className="text-xs text-black">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {methods.map((m) => (
        <span key={m} className={`${badgeBase} bg-sky-50 ring-sky-300`}>
          {paymentMethodLabel(m)}
        </span>
      ))}
    </span>
  );
}

/** Opens an outside page in a new tab, without giving it access to this one. */
export function ExternalLink({ href, children, title, className = btn }: { href: string; children: ReactNode; title?: string; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title} className={className}>
      {children}
    </a>
  );
}

/** A listing's price with its note, "—" when none; the tooltip says when it was last changed. */
export function PriceText({
  listing,
  showDate = false,
}: {
  listing: { price: number | string | null; price_note: string | null; price_updated_at: string | null } | null | undefined;
  showDate?: boolean;
}) {
  const text = listing ? formatPrice(listing.price, listing.price_note) : "";
  if (!text) return <span data-testid="price">—</span>;
  const updated = listing?.price_updated_at ? `Price updated ${formatNyDate(listing.price_updated_at)}` : undefined;
  return (
    <span data-testid="price">
      <span title={updated} className="whitespace-nowrap">
        {text}
      </span>
      {showDate && updated && <span className="block text-[11px]">{updated}</span>}
    </span>
  );
}

export function OrderButton({ link }: { link: Parameters<typeof orderTarget>[0] }) {
  const t = orderTarget(link);
  if (t.kind === "none") {
    return (
      <button type="button" disabled title={t.title} className={btn} data-testid="order-button" data-kind="none">
        {t.label}
      </button>
    );
  }
  return (
    <a href={t.href} target="_blank" rel="noopener noreferrer" title={t.title} className={btnPrimary} data-testid="order-button" data-kind={t.kind}>
      {t.label}
    </a>
  );
}

const qty = (v: unknown, unit: string) => {
  const q = formatQuantity(v as never);
  return q === "" ? "—" : `${q}${unit ? ` ${unit}` : ""}`;
};

function Contact({ supplier }: { supplier: Supplier }) {
  if (!supplier.contact_name && !supplier.contact_email && !supplier.contact_phone) return <span>—</span>;
  return (
    <div className="space-y-0.5">
      {supplier.contact_name && <div>{supplier.contact_name}</div>}
      {supplier.contact_email && (
        <div>
          <a className={linkBtn} href={`mailto:${supplier.contact_email}`}>
            {supplier.contact_email}
          </a>
        </div>
      )}
      {supplier.contact_phone && (
        <div>
          <a className={linkBtn} href={`tel:${supplier.contact_phone.replace(/[^\d+]/g, "")}`}>
            {supplier.contact_phone}
          </a>
        </div>
      )}
    </div>
  );
}

export type TableHandlers = {
  onToggle: (materialId: string) => void;
  onAddSupplier: (row: MaterialRow) => void;
  onEditLink: (row: MaterialRow, link: LinkWithSupplier) => void;
  onEditSupplier: (supplier: Supplier) => void;
  onRemoveLink: (row: MaterialRow, link: LinkWithSupplier) => void;
  onMakePreferred: (row: MaterialRow, link: LinkWithSupplier) => void;
  onCreatePo: (supplierId: string, materialIds: string[]) => void;
};

type AnyListing = LinkWithSupplier | EquipmentLinkWithSupplier;

/**
 * The expanded supplier rows under a raw material or an equipment item, one
 * per active listing, preferred first. Raw materials show COA and pack;
 * equipment shows the model or part number. Both show the price.
 */
function ListingSubtable<L extends AnyListing>({
  kind,
  ownerId,
  ownerName,
  listings,
  onAdd,
  onEdit,
  onEditSupplier,
  onRemove,
  onMakePreferred,
  onCreatePo,
}: {
  kind: "raw" | "equipment";
  ownerId: string;
  ownerName: string;
  listings: readonly L[];
  onAdd: () => void;
  onEdit: (l: L) => void;
  onEditSupplier: (s: Supplier) => void;
  onRemove: (l: L) => void;
  onMakePreferred: (l: L) => void;
  onCreatePo: (l: L) => void;
}) {
  return (
    <div className="space-y-2 bg-zinc-50 px-3 py-3" data-testid={`subtable-${ownerId}`}>
      {listings.length === 0 ? (
        <p className="text-xs text-black">No suppliers yet for {ownerName}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-left text-xs text-black">
            <thead className="text-[11px] text-black">
              <tr className="border-b border-zinc-200">
                <th className="px-2 py-1 font-semibold">Preferred</th>
                <th className="px-2 py-1 font-semibold">Supplier</th>
                <th className="px-2 py-1 font-semibold">Links</th>
                <th className="px-2 py-1 font-semibold">Contact</th>
                <th className="px-2 py-1 font-semibold">Payment</th>
                {kind === "raw" && <th className="px-2 py-1 font-semibold">COA</th>}
                <th className="px-2 py-1 font-semibold">{kind === "raw" ? "Item / pack" : "Model or part number"}</th>
                <th className="px-2 py-1 font-semibold">Price</th>
                <th className="px-2 py-1 font-semibold">Notes</th>
                <th className="px-2 py-1 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {listings.map((l) => (
                <tr key={l.id} className="border-b border-zinc-100 align-top" data-testid="supplier-link-row">
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => !l.is_preferred && onMakePreferred(l)}
                      aria-pressed={l.is_preferred}
                      aria-label={l.is_preferred ? `${l.supplier.name} is the preferred supplier` : `Make ${l.supplier.name} the preferred supplier`}
                      title={l.is_preferred ? "Preferred supplier" : "Make this the preferred supplier"}
                      className={`text-base leading-none ${l.is_preferred ? "text-amber-500" : "text-black hover:text-amber-500"}`}
                    >
                      {l.is_preferred ? "★" : "☆"}
                    </button>
                  </td>
                  <td className="px-2 py-1.5">
                    <button type="button" className={linkBtn} onClick={() => onEditSupplier(l.supplier)} title="Edit supplier details">
                      {l.supplier.name}
                    </button>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-col items-start gap-1">
                      {l.product_url ? (
                        <ExternalLink href={l.product_url} title={`Product page at ${l.supplier.name}`}>
                          Product page
                        </ExternalLink>
                      ) : (
                        <span>No product link</span>
                      )}
                      {l.supplier.website_url && (
                        <ExternalLink href={l.supplier.website_url} title={`Website of ${l.supplier.name}`}>
                          Website
                        </ExternalLink>
                      )}
                      {l.link_updated_at && <span className="text-[11px]">Link updated {formatNyDate(l.link_updated_at)}</span>}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <Contact supplier={l.supplier} />
                  </td>
                  <td className="px-2 py-1.5">
                    <PaymentChips methods={l.supplier.payment_methods} />
                    {l.supplier.payment_notes && <p className="mt-1 whitespace-pre-wrap">{l.supplier.payment_notes}</p>}
                  </td>
                  {kind === "raw" && <td className="px-2 py-1.5">{coaPolicyLabel((l as LinkWithSupplier).coa_policy)}</td>}
                  <td className="px-2 py-1.5">
                    {l.supplier_item && <div>{l.supplier_item}</div>}
                    {kind === "raw" && (l as LinkWithSupplier).pack_info && <div>{(l as LinkWithSupplier).pack_info}</div>}
                    {!l.supplier_item && (kind !== "raw" || !(l as LinkWithSupplier).pack_info) && "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    <PriceText listing={l} showDate />
                  </td>
                  <td className="max-w-xs px-2 py-1.5">
                    {l.supplier.ordering_notes && (
                      <p className="whitespace-pre-wrap">
                        <span className="font-semibold">Ordering: </span>
                        {l.supplier.ordering_notes}
                      </p>
                    )}
                    {l.notes && (
                      <p className="mt-1 whitespace-pre-wrap">
                        <span className="font-semibold">{kind === "raw" ? "Link: " : "Listing: "}</span>
                        {l.notes}
                      </p>
                    )}
                    {!l.supplier.ordering_notes && !l.notes && "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      <button type="button" className={btn} onClick={() => onEdit(l)}>
                        Edit
                      </button>
                      <button type="button" className={btn} onClick={() => onCreatePo(l)} data-testid="subtable-create-po">
                        Create PO
                      </button>
                      <button type="button" className={btnDanger} onClick={() => onRemove(l)}>
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className={btn} onClick={onAdd}>
        + Add supplier
      </button>
    </div>
  );
}

export function ProcurementTable({
  rows,
  expanded,
  highlightId,
  handlers: h,
}: {
  rows: readonly MaterialRow[];
  expanded: ReadonlySet<string>;
  highlightId?: string | null;
  handlers: TableHandlers;
}) {
  if (rows.length === 0) return <p className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-black">No raw materials match.</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
      <table className="min-w-full border-collapse text-left text-xs text-black" data-testid="procurement-table">
        <thead className="bg-zinc-50 text-[11px] text-black">
          <tr>
            <th className="w-6 px-2 py-2" aria-label="Expand" />
            <th className="px-2 py-2 font-semibold">Material</th>
            <th className="px-2 py-2 font-semibold">On hand</th>
            <th className="px-2 py-2 font-semibold">Par level</th>
            <th className="px-2 py-2 font-semibold">Stock alert</th>
            <th className="px-2 py-2 font-semibold">Preferred supplier</th>
            <th className="px-2 py-2 font-semibold">Price</th>
            <th className="px-2 py-2 font-semibold">Payment</th>
            <th className="px-2 py-2 font-semibold">Ordering notes</th>
            <th className="px-2 py-2 font-semibold">Order</th>
            <th className="px-2 py-2 font-semibold">Create PO</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = row.material.id;
            const open = expanded.has(id);
            const blocker = createPoBlocker(row);
            const notes = row.preferred?.supplier.ordering_notes ?? "";
            return (
              <Fragment key={id}>
                <tr
                  id={`material-${id}`}
                  data-testid="material-row"
                  data-material-id={id}
                  className={`border-t border-zinc-100 align-top ${highlightId === id ? "bg-emerald-50" : ""}`}
                >
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => h.onToggle(id)}
                      aria-expanded={open}
                      aria-label={`${open ? "Hide" : "Show"} suppliers for ${row.name}`}
                      className="text-black"
                    >
                      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}>
                        <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </td>
                  <td className="px-2 py-2 font-medium" data-testid="material-name">
                    {row.name}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">{qty(row.quantity_on_hand ?? 0, row.unit)}</td>
                  <td className="whitespace-nowrap px-2 py-2">{qty(row.par_level, row.unit)}</td>
                  <td className="px-2 py-2">
                    <StockBadge alert={row.alert} />
                  </td>
                  <td className="px-2 py-2" data-testid="preferred-cell">
                    {row.links.length === 0 ? (
                      <div className="flex flex-col items-start gap-1">
                        <NoSupplierBadge />
                        <button type="button" className={btn} onClick={() => h.onAddSupplier(row)}>
                          Add supplier
                        </button>
                      </div>
                    ) : row.preferred ? (
                      <button type="button" className={linkBtn} onClick={() => h.onEditSupplier(row.preferred!.supplier)}>
                        {row.preferred.supplier.name}
                      </button>
                    ) : (
                      <span>No preferred supplier</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <PriceText listing={row.preferred} />
                  </td>
                  <td className="px-2 py-2">
                    <PaymentChips methods={row.preferred?.supplier.payment_methods} />
                  </td>
                  <td className="max-w-[14rem] px-2 py-2">
                    {notes ? (
                      <span className="block truncate" title={notes}>
                        {notes}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <OrderButton link={row.preferred} />
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      className={btn}
                      disabled={!!blocker}
                      title={blocker ?? `Start a Purchase Order with ${row.preferred?.supplier.name ?? ""}`}
                      onClick={() => row.preferred && h.onCreatePo(row.preferred.supplier_id, [id])}
                      data-testid="row-create-po"
                    >
                      Create PO
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={11} className="p-0">
                      <ListingSubtable
                        kind="raw"
                        ownerId={row.material.id}
                        ownerName={row.name}
                        listings={row.links}
                        onAdd={() => h.onAddSupplier(row)}
                        onEdit={(l) => h.onEditLink(row, l)}
                        onEditSupplier={h.onEditSupplier}
                        onRemove={(l) => h.onRemoveLink(row, l)}
                        onMakePreferred={(l) => h.onMakePreferred(row, l)}
                        onCreatePo={(l) => h.onCreatePo(l.supplier_id, [row.material.id])}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Read-only, above a prefilled Purchase Order. Not part of the PO: never printed, never stored. */
export function SupplierInfoBox({ info }: { info: SupplierInfo }) {
  return (
    <section className="rounded-md border border-sky-300 bg-sky-50 p-4 text-xs text-black" data-testid="supplier-info-box" aria-label="Supplier info">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-black">Supplier info: {info.name}</p>
          <p className="text-[11px] text-black">For your reference only. This is not printed on the PO.</p>
        </div>
        {info.reference_url && (
          <ExternalLink href={info.reference_url} title={`${info.reference_label} at ${info.name}`}>
            Open {info.reference_label === "Product page" ? "product page" : "website"}
          </ExternalLink>
        )}
      </div>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="font-semibold">Contact</dt>
          <dd>
            <Contact supplier={{ contact_name: info.contact_name, contact_email: info.contact_email, contact_phone: info.contact_phone } as Supplier} />
          </dd>
        </div>
        <div>
          <dt className="font-semibold">Payment methods</dt>
          <dd>
            <PaymentChips methods={info.payment_methods} />
          </dd>
        </div>
        <div>
          <dt className="font-semibold">Payment notes</dt>
          <dd className="whitespace-pre-wrap">{info.payment_notes || "—"}</dd>
        </div>
        <div>
          <dt className="font-semibold">Ordering notes</dt>
          <dd className="whitespace-pre-wrap">{info.ordering_notes || "—"}</dd>
        </div>
        {(info.prices ?? []).length > 0 && (
          <div className="sm:col-span-2" data-testid="supplier-info-prices">
            <dt className="font-semibold">Listed price</dt>
            <dd>
              <ul className="space-y-0.5">
                {(info.prices ?? []).map((p) => (
                  <li key={p.label}>
                    {(info.prices ?? []).length > 1 && <span>{p.label}: </span>}
                    <PriceText listing={p} />
                    {p.price_updated_at && <span> (Price updated {formatNyDate(p.price_updated_at)})</span>}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

// --- Equipment ------------------------------------------------------------------------------
export type EquipmentHandlers = {
  onToggle: (equipmentId: string) => void;
  onEditItem: (row: EquipmentRow) => void;
  onRestore: (row: EquipmentRow) => void;
  onAddSupplier: (row: EquipmentRow) => void;
  onEditLink: (row: EquipmentRow, link: EquipmentLinkWithSupplier) => void;
  onEditSupplier: (supplier: Supplier) => void;
  onRemoveLink: (row: EquipmentRow, link: EquipmentLinkWithSupplier) => void;
  onMakePreferred: (row: EquipmentRow, link: EquipmentLinkWithSupplier) => void;
  onCreatePo: (supplierId: string, equipmentId: string) => void;
};

/** Equipment: no quantity, par level or stock alert. Sorted by name (natural order). */
export function EquipmentTable({
  rows,
  expanded,
  highlightId,
  handlers: h,
}: {
  rows: readonly EquipmentRow[];
  expanded: ReadonlySet<string>;
  highlightId?: string | null;
  handlers: EquipmentHandlers;
}) {
  if (rows.length === 0) return <p className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-black">No equipment matches.</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
      <table className="min-w-full border-collapse text-left text-xs text-black" data-testid="equipment-table">
        <thead className="bg-zinc-50 text-[11px] text-black">
          <tr>
            <th className="w-6 px-2 py-2" aria-label="Expand" />
            <th className="px-2 py-2 font-semibold">Equipment</th>
            <th className="px-2 py-2 font-semibold">Category</th>
            <th className="px-2 py-2 font-semibold">Preferred supplier</th>
            <th className="px-2 py-2 font-semibold">Price</th>
            <th className="px-2 py-2 font-semibold">Payment</th>
            <th className="px-2 py-2 font-semibold">Ordering notes</th>
            <th className="px-2 py-2 font-semibold">Order</th>
            <th className="px-2 py-2 font-semibold">Create PO</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = row.item.id;
            const open = expanded.has(id) && !row.archived;
            const blocker = equipmentCreatePoBlocker(row);
            const notes = row.preferred?.supplier.ordering_notes ?? "";
            return (
              <Fragment key={id}>
                <tr
                  id={`equipment-${id}`}
                  data-testid="equipment-row"
                  data-equipment-id={id}
                  className={`border-t border-zinc-100 align-top ${highlightId === id ? "bg-emerald-50" : ""}`}
                >
                  <td className="px-2 py-2">
                    {!row.archived && (
                      <button type="button" onClick={() => h.onToggle(id)} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} suppliers for ${row.name}`} className="text-black">
                        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}>
                          <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                        </svg>
                      </button>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <button type="button" className="text-left font-medium text-black hover:underline" onClick={() => h.onEditItem(row)} title="Edit this equipment item" data-testid="equipment-name">
                      {row.name}
                    </button>
                    {row.archived && <span className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-[11px] font-medium text-black">Archived</span>}
                    {row.item.description && (
                      <span className="block max-w-[16rem] truncate text-[11px]" title={row.item.description}>
                        {row.item.description}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2" data-testid="equipment-category">
                    {row.category?.name ?? "—"}
                  </td>
                  <td className="px-2 py-2">
                    {row.archived ? (
                      <button type="button" className={btn} onClick={() => h.onRestore(row)}>
                        Restore
                      </button>
                    ) : row.links.length === 0 ? (
                      <div className="flex flex-col items-start gap-1">
                        <NoSupplierBadge />
                        <button type="button" className={btn} onClick={() => h.onAddSupplier(row)}>
                          Add supplier
                        </button>
                      </div>
                    ) : row.preferred ? (
                      <button type="button" className={linkBtn} onClick={() => h.onEditSupplier(row.preferred!.supplier)}>
                        {row.preferred.supplier.name}
                      </button>
                    ) : (
                      <span>No preferred supplier</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <PriceText listing={row.preferred} />
                  </td>
                  <td className="px-2 py-2">
                    <PaymentChips methods={row.preferred?.supplier.payment_methods} />
                  </td>
                  <td className="max-w-[14rem] px-2 py-2">
                    {notes ? (
                      <span className="block truncate" title={notes}>
                        {notes}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <OrderButton link={row.preferred} />
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      className={btn}
                      disabled={!!blocker}
                      title={blocker ?? `Start a Purchase Order with ${row.preferred?.supplier.name ?? ""}`}
                      onClick={() => row.preferred && h.onCreatePo(row.preferred.supplier_id, id)}
                      data-testid="equipment-create-po"
                    >
                      Create PO
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={9} className="p-0">
                      <ListingSubtable
                        kind="equipment"
                        ownerId={id}
                        ownerName={row.name}
                        listings={row.links}
                        onAdd={() => h.onAddSupplier(row)}
                        onEdit={(l) => h.onEditLink(row, l)}
                        onEditSupplier={h.onEditSupplier}
                        onRemove={(l) => h.onRemoveLink(row, l)}
                        onMakePreferred={(l) => h.onMakePreferred(row, l)}
                        onCreatePo={(l) => h.onCreatePo(l.supplier_id, id)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Tabs and back links ------------------------------------------------------------------
export function ProcurementTabs({ tab, onChange }: { tab: ProcurementTab; onChange: (t: ProcurementTab) => void }) {
  const tabs: { key: ProcurementTab; label: string }[] = [
    { key: "raw", label: "Raw Materials" },
    { key: "equipment", label: "Equipment" },
  ];
  return (
    <div className="flex gap-1 border-b border-zinc-200" role="tablist" aria-label="Procurement">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={tab === t.key}
          data-testid={`tab-${t.key}`}
          onClick={() => onChange(t.key)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium text-black ${tab === t.key ? "border-emerald-600" : "border-transparent hover:border-zinc-300"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function BackLinkFromUrl({ className }: { className: string }) {
  const tab = useSearchParams().get("tab");
  return (
    <Link href={procurementHref(tab)} className={className}>
      ← Back to Procurement
    </Link>
  );
}

/**
 * "← Back to Procurement", returning to the tab in this page's ?tab=
 * (or the tab given). Used on Suppliers, Purchase Orders and the PO form.
 */
export function BackToProcurementLink({ tab, className = linkBtn }: { tab?: string | null; className?: string }) {
  if (tab !== undefined) {
    return (
      <Link href={procurementHref(tab)} className={className}>
        ← Back to Procurement
      </Link>
    );
  }
  return (
    <Suspense
      fallback={
        <Link href="/inventory/procurement" className={className}>
          ← Back to Procurement
        </Link>
      }
    >
      <BackLinkFromUrl className={className} />
    </Suspense>
  );
}
