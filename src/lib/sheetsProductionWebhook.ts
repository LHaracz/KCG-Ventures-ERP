export type SheetsProductionRecord = {
  cycle_id: string;
  product: string;
  quantity_produced: number;
  production_date: string;
  batch_id?: string;
  notes?: string;
};

type SheetsWebhookResponseBody = {
  ok?: boolean;
};

function stripEmptyOptionals(
  record: SheetsProductionRecord,
): SheetsProductionRecord {
  const cleaned: SheetsProductionRecord = {
    cycle_id: record.cycle_id,
    product: record.product,
    quantity_produced: record.quantity_produced,
    production_date: record.production_date,
  };
  if (record.batch_id) cleaned.batch_id = record.batch_id;
  if (record.notes) cleaned.notes = record.notes;
  return cleaned;
}

/**
 * Soft-fail batched notify to the Google Sheets Apps Script webhook.
 * Never throws — production completion must not break on sheet failures.
 */
export async function notifySheetsProductionIn(
  records: SheetsProductionRecord[],
): Promise<void> {
  if (records.length === 0) return;

  const url = process.env.SHEETS_WEBHOOK_URL;
  const secret = process.env.SHEETS_WEBHOOK_SECRET;
  if (!url || !secret) {
    console.error(
      "[sheetsProductionWebhook] Missing SHEETS_WEBHOOK_URL or SHEETS_WEBHOOK_SECRET; skipping notify.",
      { recordCount: records.length },
    );
    return;
  }

  const cycleIds = records.map((r) => r.cycle_id);
  const payload = {
    secret,
    records: records.map(stripEmptyOptionals),
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    let body: SheetsWebhookResponseBody;
    try {
      body = (await response.json()) as SheetsWebhookResponseBody;
    } catch {
      console.error(
        "[sheetsProductionWebhook] Failed to parse JSON response.",
        { recordCount: records.length, cycleIds, httpStatus: response.status },
      );
      return;
    }

    if (!response.ok || body.ok !== true) {
      console.error(
        "[sheetsProductionWebhook] Webhook reported failure.",
        {
          recordCount: records.length,
          cycleIds,
          httpStatus: response.status,
          bodyOk: body.ok,
        },
      );
    }
  } catch (error) {
    console.error(
      "[sheetsProductionWebhook] Fetch failed or timed out.",
      {
        recordCount: records.length,
        cycleIds,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export function productionDateFromCycleEndDate(
  endDate: string | null | undefined,
): string {
  if (endDate) {
    const datePart = String(endDate).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  }
  return new Date().toISOString().slice(0, 10);
}
