import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { PoFormPayload } from "@/lib/purchaseOrders";

/**
 * Edit an existing purchase order. Calls update_purchase_order
 * (purchase_orders_documents.sql), which never touches po_number — a PO's
 * number is permanent once assigned — and fully replaces its lines
 * (delete-then-reinsert) rather than patching them in place, recomputing
 * subtotal/tax/total from scratch exactly like create. The "Update company
 * details from the current profile" checkbox on the form maps to
 * refresh_company_snapshot; left off, the PO keeps whatever letterhead
 * snapshot it was created or last refreshed with.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireApiUserFromBearerToken(request);
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "The server isn't configured to save purchase orders (missing service role key)." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as PoFormPayload;
    if (!Array.isArray(body?.lines)) {
      return NextResponse.json({ error: "At least one line item is required." }, { status: 400 });
    }

    const payload = {
      id,
      company_profile_id: body.company_profile_id,
      order_date: body.order_date,
      needed_by_date: body.needed_by_date,
      vendor_name: body.vendor_name,
      vendor_contact_name: body.vendor_contact_name || null,
      vendor_email: body.vendor_email || null,
      vendor_phone: body.vendor_phone || null,
      vendor_account_number: body.vendor_account_number || null,
      vendor_address_line1: body.vendor_address_line1,
      vendor_address_line2: body.vendor_address_line2 || null,
      vendor_city: body.vendor_city,
      vendor_state: body.vendor_state,
      vendor_zip: body.vendor_zip,
      vendor_country: body.vendor_country,
      ship_to: body.ship_to,
      payment_terms: body.payment_terms,
      shipping_method: body.shipping_method,
      freight_terms: body.freight_terms,
      reference_number: body.reference_number || null,
      prepared_by_name: body.prepared_by_name,
      authorized_by_name: body.authorized_by_name,
      authorized_by_title: body.authorized_by_title,
      buyer_phone: body.buyer_phone,
      buyer_email: body.buyer_email,
      shipping_cost: body.shipping_cost || "0",
      tax_exempt: !!body.tax_exempt,
      tax_rate_percent: body.tax_exempt ? "0" : body.tax_rate_percent || "0",
      special_instructions: body.special_instructions || null,
      terms_text: body.terms_text || "",
      notes_to_vendor: body.notes_to_vendor || null,
      internal_notes: body.internal_notes || null,
      refresh_company_snapshot: !!body.refresh_company_snapshot,
      lines: body.lines.map((line) => ({
        item_number: line.item_number || null,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_price: line.unit_price,
      })),
    };

    const { data, error } = await supabaseAdmin.rpc("update_purchase_order", { payload });
    if (error) return NextResponse.json({ error: error.message || "Failed to save changes to this purchase order." }, { status: 400 });

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
