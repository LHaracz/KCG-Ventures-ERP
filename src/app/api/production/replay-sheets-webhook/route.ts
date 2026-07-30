import { NextResponse } from "next/server";
import { requireApiUserFromBearerToken } from "@/lib/apiAuth";
import { normalizeBusinessType } from "@/lib/businessType";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  notifySheetsProductionIn,
  productionDateFromCycleEndDate,
  type SheetsProductionRecord,
} from "@/lib/sheetsProductionWebhook";

type TargetRow = {
  product: string | null;
  quantity_to_produce: number | null;
  target_units: number | null;
};

type BatchRow = {
  product_id: string | null;
  quantity_produced: number | null;
  batch_id: string | null;
};

/**
 * Replay the Sheets finished-goods webhook for a BotanIQals production cycle.
 * Auth: Bearer token of the cycle owner (no separate admin role in this app).
 */
export async function POST(request: Request) {
  try {
    const user = await requireApiUserFromBearerToken(request);
    const body = (await request.json()) as { cycleId?: string };
    const cycleId = body.cycleId?.trim();
    if (!cycleId) {
      return NextResponse.json({ error: "Missing cycleId." }, { status: 400 });
    }

    if (!supabaseAdmin) {
      return NextResponse.json({ error: "Server misconfiguration." }, { status: 500 });
    }

    const { data: cycle, error: cycleError } = await supabaseAdmin
      .from("production_cycles")
      .select("id, user_id, business_type, brand, end_date")
      .eq("id", cycleId)
      .eq("user_id", user.id)
      .single();

    if (cycleError || !cycle) {
      return NextResponse.json(
        { error: cycleError?.message || "Cycle not found." },
        { status: 404 },
      );
    }

    const businessType = normalizeBusinessType(cycle);
    if (businessType !== "BotanIQals") {
      return NextResponse.json(
        { error: "Sheets finished-goods webhook only applies to BotanIQals cycles." },
        { status: 400 },
      );
    }

    const productionDate = productionDateFromCycleEndDate(
      (cycle as { end_date?: string | null }).end_date,
    );

    const { data: batches, error: batchesError } = await supabaseAdmin
      .from("botaniqals_production_batches")
      .select("product_id, quantity_produced, batch_id")
      .eq("production_cycle_id", cycleId)
      .eq("user_id", user.id);

    if (batchesError) {
      return NextResponse.json({ error: batchesError.message }, { status: 500 });
    }

    const qtyByProductId = new Map<string, { qty: number; batch_id?: string }>();

    for (const batch of (batches ?? []) as BatchRow[]) {
      if (!batch.product_id) continue;
      const qty = Math.trunc(Number(batch.quantity_produced ?? 0));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const existing = qtyByProductId.get(batch.product_id);
      if (existing) {
        existing.qty += qty;
        if (!existing.batch_id && batch.batch_id) {
          existing.batch_id = String(batch.batch_id);
        }
      } else {
        qtyByProductId.set(batch.product_id, {
          qty,
          ...(batch.batch_id ? { batch_id: String(batch.batch_id) } : {}),
        });
      }
    }

    if (qtyByProductId.size === 0) {
      const { data: targets, error: targetsError } = await supabaseAdmin
        .from("production_targets")
        .select("product, quantity_to_produce, target_units")
        .eq("production_cycle", cycleId)
        .eq("user_id", user.id);

      if (targetsError) {
        return NextResponse.json({ error: targetsError.message }, { status: 500 });
      }

      for (const target of (targets ?? []) as TargetRow[]) {
        if (!target.product) continue;
        const qty = Math.trunc(
          Number(target.quantity_to_produce ?? target.target_units ?? 0),
        );
        if (!Number.isFinite(qty) || qty <= 0) continue;
        qtyByProductId.set(target.product, { qty });
      }
    }

    if (qtyByProductId.size === 0) {
      return NextResponse.json({ ok: true, sent: 0, skipped: 0 });
    }

    const productIds = Array.from(qtyByProductId.keys());
    const { data: products, error: productsError } = await supabaseAdmin
      .from("products")
      .select("id, name")
      .in("id", productIds);

    if (productsError) {
      return NextResponse.json({ error: productsError.message }, { status: 500 });
    }

    const nameById = new Map<string, string>();
    for (const row of products ?? []) {
      if (!row.id || !row.name) continue;
      nameById.set(String(row.id), String(row.name));
    }

    const records: SheetsProductionRecord[] = [];
    let skipped = 0;
    for (const [productId, entry] of qtyByProductId) {
      const productName = nameById.get(productId);
      if (!productName) {
        skipped += 1;
        console.error(
          "[replay-sheets-webhook] Missing products.name for record.",
          { cycleId, productId },
        );
        continue;
      }
      records.push({
        cycle_id: `${cycleId}:${productId}`,
        product: productName,
        quantity_produced: entry.qty,
        production_date: productionDate,
        ...(entry.batch_id ? { batch_id: entry.batch_id } : {}),
      });
    }

    await notifySheetsProductionIn(records);

    return NextResponse.json({
      ok: true,
      sent: records.length,
      skipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status =
      message === "Unauthorized." || message.includes("bearer token") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
