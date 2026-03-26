import { NextResponse } from "next/server";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { format } from "date-fns";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendNotificationEmail } from "@/lib/sendNotificationEmail";
import {
  BomLineRow,
  FreezeDryerMachineSettingsRow,
  FreezeDryerProfileRow,
  MicrogreenRow,
  ProductionCycleRow,
  ProductionTargetRow,
  ProductRow,
  YieldEntryRow,
  buildRunsForMicrogreen,
  computeDriedMicrogreenDemand,
  deriveGrowTasksFromRuns,
  estimateTraysNeededForDriedDemand,
  getProfileForMicrogreen,
  isBotanIQalsCycle,
  scheduleRunsWithTwoDayBuffer,
} from "@/lib/botaniqalsScheduling";
import { normalizeBusinessType } from "@/lib/businessType";

const CONFIG_ID = "a0000000-0000-0000-0000-000000000001";

function getCurrentHourInTimezone(timezone: string): number {
  const now = new Date();
  const zoned = toZonedTime(now, timezone);
  return zoned.getHours();
}

function getTodayStartEndUtc(timezone: string): {
  start: string;
  end: string;
  todayLabel: string;
  todayKey: string;
} {
  const now = new Date();
  const zoned = toZonedTime(now, timezone);
  const y = zoned.getFullYear();
  const m = zoned.getMonth();
  const d = zoned.getDate();
  const startOfDay = fromZonedTime(new Date(y, m, d, 0, 0, 0, 0), timezone);
  const endOfDay = fromZonedTime(new Date(y, m, d, 23, 59, 59, 999), timezone);
  return {
    start: startOfDay.toISOString(),
    end: endOfDay.toISOString(),
    todayLabel: format(zoned, "EEEE, MMM d, yyyy"),
    todayKey: format(zoned, "yyyy-MM-dd"),
  };
}

type CycleWithUser = ProductionCycleRow & {
  user_id: string;
  status?: string | null;
};

type AgendaTask = {
  userId: string;
  startAt: string;
  title: string;
  trays?: number | null;
  quantity?: number | null;
  quantityUnit?: string | null;
  sortWeight: number;
};

function toDateKeyInTimezone(input: Date | string, timezone: string): string {
  const zoned = toZonedTime(typeof input === "string" ? new Date(input) : input, timezone);
  return format(zoned, "yyyy-MM-dd");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret =
    request.headers.get("authorization")?.replace("Bearer ", "") ??
    request.headers.get("x-cron-secret") ??
    url.searchParams.get("cron_secret") ??
    "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || secret !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = supabaseAdmin;
  if (!admin) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const { data: configRow, error: configErr } = await admin
    .from("notification_config")
    .select("recipient_emails, timezone, production_reminder_hours, low_stock_digest_hour")
    .eq("id", CONFIG_ID)
    .maybeSingle();

  if (configErr || !configRow) {
    return NextResponse.json({ error: "Notification config not found", detail: configErr?.message }, { status: 502 });
  }

  const timezone = (configRow.timezone as string) || "America/New_York";
  const digestHour = Number(configRow.low_stock_digest_hour) ?? 7;
  const recipientEmails = (configRow.recipient_emails as string)
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (recipientEmails.length === 0) {
    return NextResponse.json({ ok: true, message: "No recipients configured" });
  }

  const currentHour = getCurrentHourInTimezone(timezone);
  if (currentHour !== digestHour) {
    return NextResponse.json({
      ok: true,
      message: "Not scheduled hour for daily digest",
      currentHour,
      digestHour,
      timezone,
    });
  }

  const { start, end, todayLabel, todayKey } = getTodayStartEndUtc(timezone);

  // Idempotency: if already sent today (in timezone window), skip duplicate sends.
  const { data: existingDigest } = await admin
    .from("notifications")
    .select("id")
    .eq("type", "daily_digest")
    .gte("created_at", start)
    .lte("created_at", end)
    .limit(1)
    .maybeSingle();
  if (existingDigest?.id) {
    return NextResponse.json({
      ok: true,
      message: "Daily digest already sent for today",
      todayKey,
      timezone,
    });
  }

  const sections: string[] = [];
  const title = `KCG Ventures ERP – Daily Digest (${todayLabel})`;

  // Section 1: Today's production tasks (all accounts, grouped by account).
  // BotanIQals tasks are recomputed to match Schedule page logic; MiniLeaf uses schedule_events.
  const activeStatuses = ["draft", "planned"];
  const { data: cycles, error: cyclesErr } = await admin
    .from("production_cycles")
    .select("id, user_id, start_date, end_date, business_type, brand, status")
    .in("status", activeStatuses);
  if (cyclesErr) {
    return NextResponse.json(
      { error: "Failed to load production cycles", detail: cyclesErr.message },
      { status: 500 },
    );
  }
  const cycleRows = (cycles || []) as CycleWithUser[];
  const activeCycles = cycleRows.filter((c) => !!c.user_id);
  const activeCycleIds = activeCycles.map((c) => c.id);

  const [targetsRes, productsRes, bomRes, mgRes, yieldRes, profilesRes, machineRes, planLinesRes] =
    await Promise.all([
      admin.from("production_targets").select("*").in("production_cycle", activeCycleIds),
      admin.from("products").select("*"),
      admin.from("bom_lines").select("*"),
      admin.from("microgreens").select("*"),
      admin.from("yield_entries").select("*"),
      admin.from("freeze_dryer_profiles").select("*"),
      admin.from("freeze_dryer_machine_settings").select("*").maybeSingle(),
      admin
        .from("production_plan_lines")
        .select(
          "id, user_id, production_cycle, business_type, microgreen, run_number, trays_this_run, soak_date, drain_date, sow_date, light_date, harvest_date",
        )
        .in("production_cycle", activeCycleIds),
    ]);

  const dependencyError =
    targetsRes.error ||
    productsRes.error ||
    bomRes.error ||
    mgRes.error ||
    yieldRes.error ||
    profilesRes.error ||
    machineRes.error ||
    planLinesRes.error;
  if (dependencyError) {
    return NextResponse.json(
      { error: "Failed to load digest dependencies", detail: dependencyError.message },
      { status: 500 },
    );
  }

  const targets = (targetsRes.data || []) as ProductionTargetRow[];
  const products = (productsRes.data || []) as ProductRow[];
  const bomLines = (bomRes.data || []) as BomLineRow[];
  const microgreens = (mgRes.data || []) as MicrogreenRow[];
  const yieldEntries = (yieldRes.data || []) as YieldEntryRow[];
  const profiles = (profilesRes.data || []) as FreezeDryerProfileRow[];
  const machine = (machineRes.data || null) as FreezeDryerMachineSettingsRow | null;
  const planLines = (planLinesRes.data || []) as Array<{
    id: string;
    user_id: string;
    production_cycle: string;
    business_type?: string | null;
    microgreen?: string | null;
    run_number?: number | null;
    trays_this_run?: number | null;
    soak_date?: string | null;
    drain_date?: string | null;
    sow_date?: string | null;
    light_date?: string | null;
    harvest_date?: string | null;
  }>;
  const cycleById = new Map(activeCycles.map((c) => [c.id, c]));

  const targetsByCycleId = new Map<string, ProductionTargetRow[]>();
  for (const t of targets) {
    const current = targetsByCycleId.get(t.production_cycle) || [];
    current.push(t);
    targetsByCycleId.set(t.production_cycle, current);
  }

  const dryFractionByMicrogreen: Record<string, number | null> = {};
  for (const mg of microgreens) {
    const profile = profiles.find((p) => p.linked_microgreen_id === mg.id) || null;
    dryFractionByMicrogreen[mg.id] = profile?.dry_matter_fraction ?? null;
  }

  const rawTasks: AgendaTask[] = [];

  // MiniLeaf from production_plan_lines (source-of-truth for generated plan rows),
  // constrained to active/planned cycles and today's timezone date.
  const miniLeafTaskDefs: Array<{
    key: "soak_date" | "drain_date" | "sow_date" | "light_date" | "harvest_date";
    label: string;
  }> = [
    { key: "soak_date", label: "soak" },
    { key: "drain_date", label: "drain" },
    { key: "sow_date", label: "sow" },
    { key: "light_date", label: "move_to_light" },
    { key: "harvest_date", label: "harvest" },
  ];
  for (const line of planLines) {
    const cycle = cycleById.get(line.production_cycle);
    if (!cycle) continue;
    const isMiniLeafLine =
      normalizeBusinessType({
        business_type: line.business_type || cycle.business_type,
        brand: cycle.brand,
      }) === "MiniLeaf";
    if (!isMiniLeafLine) continue;
    const mg = microgreens.find((m) => m.id === line.microgreen);
    for (const def of miniLeafTaskDefs) {
      const eventAt = line[def.key];
      if (!eventAt) continue;
      if (toDateKeyInTimezone(eventAt, timezone) !== todayKey) continue;
      rawTasks.push({
        userId: line.user_id || cycle.user_id,
        startAt: eventAt,
        title: `${def.label} ${mg?.name ?? line.microgreen ?? ""}`.trim(),
        trays: line.trays_this_run ?? null,
        quantity: null,
        quantityUnit: null,
        sortWeight: 1,
      });
    }
  }

  // BotanIQals recompute from live schedule inputs (same logic as Schedule page).
  const botaniqalsCycles = activeCycles.filter(isBotanIQalsCycle);
  for (const cycle of botaniqalsCycles) {
    const cycleTargets = targetsByCycleId.get(cycle.id) || [];
    const demand = computeDriedMicrogreenDemand(cycleTargets, products, bomLines);
    const trayEst = estimateTraysNeededForDriedDemand(
      demand,
      yieldEntries,
      dryFractionByMicrogreen,
    );

    const numMachines = Number(machine?.number_of_freeze_dryers ?? 1);
    const defaultProfileFreshCapacityG = Number(
      machine?.default_fresh_load_per_tray_g ?? 0,
    );
    const allRuns = trayEst.flatMap((t) => {
      const prof = getProfileForMicrogreen(
        t.microgreenId,
        demand[t.microgreenId]?.explicitProfileId ?? null,
        profiles,
      );
      const profileFreshCapacityG = Number(
        prof?.fresh_load_per_tray_g_override ?? defaultProfileFreshCapacityG,
      );
      const avgFreshGPerTray = Number(t.avgFreshGPerTray ?? 0);
      const traysPerMachineThisProfile =
        profileFreshCapacityG > 0 && avgFreshGPerTray > 0
          ? Math.max(1, Math.floor(profileFreshCapacityG / avgFreshGPerTray))
          : 1;
      const capacityTraysPerRun = traysPerMachineThisProfile * numMachines;
      return buildRunsForMicrogreen(
        t.microgreenId,
        t.traysNeeded,
        capacityTraysPerRun,
        prof?.id ?? null,
      );
    });

    const { scheduled } = scheduleRunsWithTwoDayBuffer(
      cycle,
      allRuns,
      profiles,
      machine,
      2,
    );
    const growTasks = deriveGrowTasksFromRuns(scheduled, microgreens);

    for (const task of growTasks) {
      if (toDateKeyInTimezone(task.date, timezone) !== todayKey) continue;
      const mg = microgreens.find((m) => m.id === task.microgreenId);
      rawTasks.push({
        userId: cycle.user_id,
        startAt: task.date.toISOString(),
        title: `${task.taskType} ${mg?.name ?? task.microgreenId}`,
        trays: task.trays,
        quantity: null,
        quantityUnit: null,
        sortWeight: 1,
      });
    }
    for (const run of scheduled) {
      if (toDateKeyInTimezone(run.runStart, timezone) !== todayKey) continue;
      const mg = microgreens.find((m) => m.id === run.microgreenId);
      rawTasks.push({
        userId: cycle.user_id,
        startAt: run.runStart.toISOString(),
        title: `Freeze-dry run #${run.runIndex} ${mg?.name ?? run.microgreenId}`,
        trays: run.trays,
        quantity: null,
        quantityUnit: null,
        sortWeight: 2,
      });
    }
  }

  // Dedupe and group by user.
  const deduped = new Map<string, AgendaTask>();
  for (const task of rawTasks) {
    const taskKey = [
      task.userId,
      task.title.toLowerCase(),
      toDateKeyInTimezone(task.startAt, timezone),
      task.trays ?? "",
      task.quantity ?? "",
      task.quantityUnit ?? "",
      new Date(task.startAt).toISOString().slice(0, 16),
    ].join("|");
    if (!deduped.has(taskKey)) deduped.set(taskKey, task);
  }

  const byUser = new Map<string, AgendaTask[]>();
  for (const task of deduped.values()) {
    const current = byUser.get(task.userId) || [];
    current.push(task);
    byUser.set(task.userId, current);
  }
  for (const list of byUser.values()) {
    list.sort((a, b) => {
      if (a.sortWeight !== b.sortWeight) return a.sortWeight - b.sortWeight;
      return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
    });
  }

  const { data: usersData } = await admin.auth.admin.listUsers();
  const userEmails = new Map<string, string>();
  for (const u of usersData?.users ?? []) {
    if (u.email) userEmails.set(u.id, u.email);
  }

  const agendaParts: string[] = [`<h2>Today's Production Tasks (${escapeHtml(todayLabel)})</h2>`];
  if (byUser.size === 0) {
    agendaParts.push("<p>No microgreen-grow or freeze-dryer tasks scheduled for today.</p>");
  } else {
      for (const [userId, userEvents] of byUser) {
      const email = userEmails.get(userId) ?? userId.slice(0, 8);
      agendaParts.push(`<h3>Account (${escapeHtml(email)})</h3><ul>`);
      for (const ev of userEvents) {
        const zonedTime = toZonedTime(new Date(ev.startAt), timezone);
        const time = format(zonedTime, "h:mm a");
        let line = escapeHtml(ev.title || "Event");
        line = `[${time}] ${line}`;
        if (ev.trays != null) line += ` – ${ev.trays} trays`;
        if (ev.quantity != null && ev.quantityUnit) {
          line += ` – ${ev.quantity} ${escapeHtml(ev.quantityUnit)}`;
        }
        agendaParts.push(`<li>${line}</li>`);
      }
      agendaParts.push("</ul>");
    }
  }
  sections.push(agendaParts.join(""));

  // Section 2: Low-stock digest (once daily)
  const { data: lowItems } = await admin
    .from("inventory_items")
    .select("id, name, unit, quantity_on_hand, par_level")
    .not("par_level", "is", null);

  const atOrBelowPar = (lowItems || []).filter(
    (row: { quantity_on_hand: number; par_level: number | null }) =>
      row.par_level != null &&
      Number(row.quantity_on_hand) <= Number(row.par_level),
  );
  if (atOrBelowPar.length > 0) {
    const lines = atOrBelowPar.map(
      (r: {
        name: string;
        quantity_on_hand: number;
        par_level: number | null;
        unit: string;
      }) =>
        `<tr><td>${escapeHtml(r.name)}</td><td>${r.quantity_on_hand} ${escapeHtml(r.unit)}</td><td>${r.par_level} ${escapeHtml(r.unit)}</td></tr>`,
    );
    sections.push(
      `<h2>Low Stock (at or below par)</h2><table border="1" cellpadding="6" style="border-collapse:collapse"><thead><tr><th>Item</th><th>QOH</th><th>Par</th></tr></thead><tbody>${lines.join("")}</tbody></table>`,
    );
  } else {
    sections.push("<h2>Low Stock</h2><p>No items are currently at or below par level.</p>");
  }

  if (sections.length === 0) {
    return NextResponse.json({ ok: true, message: "No content for this hour" });
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="font-family:sans-serif;max-width:640px">${sections.join("<hr/>")}</body></html>`;

  const { ok, error } = await sendNotificationEmail(recipientEmails, title, html);
  if (!ok) {
    return NextResponse.json({ error: "Failed to send email", detail: error }, { status: 500 });
  }

  // In-app: insert one notification per user so everyone sees the digest
  const body = sections.join("\n\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const userIds = usersData?.users?.map((u) => u.id) ?? [];
  for (const uid of userIds) {
    await admin.from("notifications").insert({
      user_id: uid,
      type: "daily_digest",
      title,
      body: body.slice(0, 10000),
    });
  }

  return NextResponse.json({
    ok: true,
    recipients: recipientEmails.length,
    todayKey,
    timezone,
    accountsWithTasks: byUser.size,
    lowStockCount: atOrBelowPar.length,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
