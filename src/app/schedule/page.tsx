\"use client\";

import { useEffect, useMemo, useState, FormEvent } from \"react\";
import { AuthGuard } from \"@/components/AuthGuard\";
import { useSupabase } from \"@/components/InstantProvider\";
import { formatDate } from \"@/lib/date\";
import {
  AggregatedIngredientRequirement,
  BomLineForScaling,
  CycleIngredientRequirement,
  ManufacturingCycle,
  aggregateCycleRequirements,
  scaleBomLines,
  splitIntoCycles,
} from \"@/lib/manufacturing\";

type ScheduleEvent = {
  id: string;
  production_cycle_id: string | null;
  business_type: string | null;
  product_id: string | null;
  product_variant_id: string | null;
  microgreen_id: string | null;
  freeze_dryer_profile_id: string | null;
  event_type: string;
  title: string;
  start_at: string;
  end_at: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  trays: number | null;
  run_number: number | null;
  machine_number: number | null;
  status: string;
  notes: string | null;
};

type ProductRow = {
  id: string;
  name: string;
  unit: string;
  is_microgreen?: boolean;
  target_batch_size?: number | null;
  target_batch_unit?: string | null;
};

type ManufacturingForm = {
  productId: string;
  plannedQuantity: number | \"\";
  plannedDate: string;
  assignedTo: string;
  notes: string;
};

export default function SchedulePage() {
  const { user, supabase } = useSupabase();

  const [activeTab, setActiveTab] = useState<\"agenda\" | \"manufacturing\">(
    \"agenda\",
  );

  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [bomLines, setBomLines] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [isLoadingManufacturing, setIsLoadingManufacturing] = useState(true);
  const [manufacturingError, setManufacturingError] = useState<string | null>(
    null,
  );

  const [form, setForm] = useState<ManufacturingForm>({
    productId: \"\",
    plannedQuantity: \"\",
    plannedDate: \"\",
    assignedTo: \"\",
    notes: \"\",
  });
  const [savingManufacturing, setSavingManufacturing] = useState(false);

  useEffect(() => {
    if (!user) return;
    const loadEvents = async () => {
      setIsLoadingEvents(true);
      setEventsError(null);
      const { data, error } = await supabase
        .from(\"schedule_events\")
        .select(\"*\")
        .eq(\"user_id\", user.id)
        .order(\"start_at\", { ascending: true });
      if (error) setEventsError(error.message);
      else setEvents((data || []) as ScheduleEvent[]);
      setIsLoadingEvents(false);
    };
    loadEvents();
  }, [user, supabase]);

  useEffect(() => {
    if (!user) return;
    const loadManufacturingData = async () => {
      setIsLoadingManufacturing(true);
      setManufacturingError(null);
      const [pRes, bRes, iRes] = await Promise.all([
        supabase.from(\"products\").select(\"*\").order(\"name\", {
          ascending: true,
        }),
        supabase.from(\"bom_lines\").select(\"*\"),
        supabase.from(\"inventory_items\").select(\"*\"),
      ]);
      if (pRes.error || bRes.error || iRes.error) {
        setManufacturingError(
          pRes.error?.message ||
            bRes.error?.message ||
            iRes.error?.message ||
            \"Failed to load manufacturing data.\",
        );
      } else {
        setProducts((pRes.data || []) as ProductRow[]);
        setBomLines(bRes.data || []);
        setItems(iRes.data || []);
      }
      setIsLoadingManufacturing(false);
    };
    loadManufacturingData();
  }, [user, supabase]);

  const eventsByDate = useMemo(() => {
    const map: Record<string, ScheduleEvent[]> = {};
    for (const ev of events) {
      const dateKey = ev.start_at.slice(0, 10);
      if (!map[dateKey]) map[dateKey] = [];
      map[dateKey].push(ev);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [events]);

  const manufacturableProducts = useMemo(
    () => products.filter((p) => !p.is_microgreen),
    [products],
  );

  const selectedProduct = useMemo(
    () => manufacturableProducts.find((p) => p.id === form.productId) || null,
    [manufacturableProducts, form.productId],
  );

  const targetBatchSize =
    selectedProduct?.target_batch_size != null
      ? Number(selectedProduct.target_batch_size)
      : null;

  const bomLinesForProduct: BomLineForScaling[] = useMemo(() => {
    if (!selectedProduct) return [];
    return bomLines
      .filter((b: any) => b.product === selectedProduct.id)
      .map((b: any) => {
        const item = items.find((i: any) => i.id === b.inventory_item);
        const ingredientName = item?.name ?? b.material_name_snapshot ?? \"\"; // fall back to snapshot when present
        return {
          bomLineId: b.id,
          productId: selectedProduct.id,
          ingredientId: b.inventory_item || b.id,
          ingredientName: ingredientName || \"Unknown ingredient\",
          qtyPerUnit: Number(b.qty_per_unit || 0),
          unitLabel: b.unit_label || selectedProduct.unit || \"unit\",
        } as BomLineForScaling;
      })
      .filter((line) => line.qtyPerUnit > 0);
  }, [bomLines, items, selectedProduct]);

  const manufacturingCycles: ManufacturingCycle[] = useMemo(() => {
    const plannedQtyNumber =
      form.plannedQuantity === \"\" ? 0 : Number(form.plannedQuantity || 0);
    if (!targetBatchSize || targetBatchSize <= 0) return [];
    if (!plannedQtyNumber || plannedQtyNumber <= 0) return [];
    return splitIntoCycles(plannedQtyNumber, targetBatchSize);
  }, [form.plannedQuantity, targetBatchSize]);

  const cycleRequirements: CycleIngredientRequirement[][] = useMemo(() => {
    if (!manufacturingCycles.length || !bomLinesForProduct.length) return [];
    return manufacturingCycles.map((cycle) => {
      const scaled = scaleBomLines(bomLinesForProduct, cycle.quantity);
      return scaled.map((req) => ({
        ...req,
        cycleIndex: cycle.index,
      }));
    });
  }, [manufacturingCycles, bomLinesForProduct]);

  const totalRequirements: AggregatedIngredientRequirement[] = useMemo(
    () => aggregateCycleRequirements(cycleRequirements),
    [cycleRequirements],
  );

  const handleManufacturingSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!selectedProduct) {
      setManufacturingError(\"Select a product.\");
      return;
    }
    const plannedQtyNumber =
      form.plannedQuantity === \"\" ? 0 : Number(form.plannedQuantity || 0);
    if (!plannedQtyNumber || plannedQtyNumber <= 0) {
      setManufacturingError(\"Enter a planned quantity.\");
      return;
    }
    if (!form.plannedDate) {
      setManufacturingError(\"Choose a planned date.\");
      return;
    }
    if (!targetBatchSize || targetBatchSize <= 0) {
      setManufacturingError(
        \"Selected product does not have a target batch size. Set it in Products & BOM.\",
      );
      return;
    }
    if (!manufacturingCycles.length) {
      setManufacturingError(
        \"No cycles could be generated. Check planned quantity and target batch size.\",
      );
      return;
    }

    setSavingManufacturing(true);
    setManufacturingError(null);

    try {
      const date = new Date(form.plannedDate);
      const startIso = date.toISOString();

      const inserts = manufacturingCycles.map((cycle) => ({
        production_cycle_id: null,
        business_type: \"Manufacturing\",
        product_id: selectedProduct.id,
        product_variant_id: null,
        microgreen_id: null,
        freeze_dryer_profile_id: null,
        event_type: \"manufacturing_cycle\",
        title: `${selectedProduct.name} – cycle ${cycle.index}`,
        start_at: startIso,
        end_at: null,
        quantity: cycle.quantity,
        quantity_unit: selectedProduct.unit,
        trays: null,
        run_number: cycle.index,
        machine_number: null,
        status: \"planned\",
        notes: form.notes || null,
        user_id: user.id,
        assigned_to: form.assignedTo || null,
      }));

      const { error } = await supabase
        .from(\"schedule_events\")
        .insert(inserts as any);
      if (error) {
        throw error;
      }

      const { data: refreshed } = await supabase
        .from(\"schedule_events\")
        .select(\"*\")
        .eq(\"user_id\", user.id)
        .order(\"start_at\", { ascending: true });
      setEvents((refreshed || []) as ScheduleEvent[]);

      setForm((prev) => ({
        ...prev,
        plannedQuantity: \"\",
        notes: \"\",
      }));
    } catch (err: any) {
      setManufacturingError(
        err?.message || \"Failed to save manufacturing schedule.\",
      );
    } finally {
      setSavingManufacturing(false);
    }
  };

  return (
    <AuthGuard>
      <div className=\"mx-auto max-w-5xl space-y-6\">
        <header>
          <h1 className=\"mb-1 text-2xl font-semibold text-zinc-900\">
            Production Schedule
          </h1>
          <p className=\"text-sm text-zinc-600\">
            View grow, harvest, freeze-dryer, packaging, and supplement
            manufacturing events generated for your production.
          </p>
        </header>

        <div className=\"flex gap-2 border-b border-zinc-200 text-xs\">
          <button
            type=\"button\"
            onClick={() => setActiveTab(\"agenda\")}
            className={`border-b-2 px-3 py-1.5 ${
              activeTab === \"agenda\"
                ? \"border-emerald-600 text-emerald-700\"
                : \"border-transparent text-zinc-600 hover:text-zinc-900\"
            }`}
          >
            Agenda
          </button>
          <button
            type=\"button\"
            onClick={() => setActiveTab(\"manufacturing\")}
            className={`border-b-2 px-3 py-1.5 ${
              activeTab === \"manufacturing\"
                ? \"border-emerald-600 text-emerald-700\"
                : \"border-transparent text-zinc-600 hover:text-zinc-900\"
            }`}
          >
            Supplement manufacturing
          </button>
        </div>

        {activeTab === \"agenda\" && (
          <>
            {isLoadingEvents ? (
              <p className=\"text-sm text-black\">Loading schedule…</p>
            ) : eventsError ? (
              <p className=\"text-sm text-red-600\" role=\"alert\">
                {eventsError}
              </p>
            ) : events.length === 0 ? (
              <p className=\"text-sm text-black\">
                No scheduled events yet. Generate a schedule from a production
                cycle planner or add manufacturing cycles to see tasks appear
                here.
              </p>
            ) : (
              <section className=\"space-y-4 rounded-md border border-zinc-200 bg-white p-4 text-xs\">
                <h2 className=\"text-sm font-semibold text-zinc-900\">
                  Agenda view (by date)
                </h2>
                <div className=\"max-h-[36rem] space-y-4 overflow-y-auto\">
                  {eventsByDate.map(([dateKey, dayEvents]) => (
                    <div key={dateKey}>
                      <div className=\"mb-1.5 text-[11px] font-semibold text-zinc-700\">
                        {formatDate(dateKey)}
                      </div>
                      <div className=\"space-y-2\">
                        {dayEvents.map((ev) => (
                          <div
                            key={ev.id}
                            className=\"rounded border border-zinc-100 bg-zinc-50 px-2 py-1.5\"
                          >
                            <div
                              className=\"flex cursor-pointer items-start justify-between\"
                              onClick={() =>
                                setExpandedId(
                                  expandedId === ev.id ? null : ev.id,
                                )
                              }
                            >
                              <div>
                                <div className=\"text-[11px] font-semibold text-zinc-900\">
                                  {ev.title}
                                </div>
                                <div className=\"text-[11px] text-zinc-600\">
                                  <span className=\"capitalize\">
                                    {ev.event_type}
                                  </span>
                                  {ev.trays != null &&
                                    ` · Trays: ${ev.trays}`}
                                  {ev.quantity != null &&
                                    ev.quantity_unit &&
                                    ` · ${ev.quantity} ${ev.quantity_unit}`}
                                  {ev.machine_number != null &&
                                    ` · Machine #${ev.machine_number}`}
                                  {ev.run_number != null &&
                                    ` · Run #${ev.run_number}`}
                                </div>
                                <div className=\"mt-0.5 text-[10px] text-zinc-500\">
                                  Status:{" "}
                                  <span className=\"capitalize\">
                                    {ev.status || \"planned\"}
                                  </span>
                                </div>
                              </div>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                  ev.status === \"infeasible\"
                                    ? \"bg-red-100 text-red-700\"
                                    : ev.status === \"warning\"
                                    ? \"bg-amber-100 text-amber-700\"
                                    : \"bg-emerald-100 text-emerald-700\"
                                }`}
                              >
                                {ev.event_type}
                              </span>
                            </div>
                            {expandedId === ev.id && (
                              <div className=\"mt-2 border-t border-zinc-200 pt-2 text-[10px] text-zinc-600\">
                                {ev.business_type && (
                                  <div>Business: {ev.business_type}</div>
                                )}
                                {ev.quantity != null &&
                                  ev.quantity_unit && (
                                    <div>
                                      Quantity: {ev.quantity}{" "}
                                      {ev.quantity_unit}
                                    </div>
                                  )}
                                {ev.trays != null && (
                                  <div>Trays: {ev.trays}</div>
                                )}
                                {ev.notes && <div>Notes: {ev.notes}</div>}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {activeTab === \"manufacturing\" && (
          <section className=\"space-y-4 rounded-md border border-zinc-200 bg-white p-4 text-xs\">
            <h2 className=\"text-sm font-semibold text-zinc-900\">
              Supplement manufacturing schedule
            </h2>
            <p className=\"text-[11px] text-zinc-600\">
              Plan manufacturing cycles for finished products using their Bills
              of Materials and target batch sizes defined in Products &amp; BOM.
            </p>

            {isLoadingManufacturing ? (
              <p className=\"text-xs text-black\">Loading manufacturing data…</p>
            ) : manufacturingError ? (
              <p className=\"text-xs text-red-600\" role=\"alert\">
                {manufacturingError}
              </p>
            ) : (
              <>
                <form
                  onSubmit={handleManufacturingSubmit}
                  className=\"grid gap-3 border-b border-zinc-200 pb-4 text-xs sm:grid-cols-2\"
                >
                  <div className=\"space-y-2\">
                    <div>
                      <label className=\"mb-1 block font-medium text-zinc-800\">
                        Product
                      </label>
                      <select
                        value={form.productId}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            productId: e.target.value,
                          }))
                        }
                        required
                        className=\"w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500\"
                      >
                        <option value=\"\">Select product…</option>
                        {manufacturableProducts.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className=\"mb-1 block font-medium text-zinc-800\">
                        Planned quantity
                      </label>
                      <input
                        type=\"number\"
                        min={1}
                        value={form.plannedQuantity}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            plannedQuantity:
                              e.target.value === \"\"
                                ? \"\"
                                : Number(e.target.value),
                          }))
                        }
                        required
                        className=\"w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500\"
                      />
                    </div>
                    <div>
                      <label className=\"mb-1 block font-medium text-zinc-800\">
                        Planned date
                      </label>
                      <input
                        type=\"date\"
                        value={form.plannedDate}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            plannedDate: e.target.value,
                          }))
                        }
                        required
                        className=\"w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500\"
                      />
                    </div>
                  </div>
                  <div className=\"space-y-2\">
                    <div>
                      <label className=\"mb-1 block font-medium text-zinc-800\">
                        Assigned person (optional)
                      </label>
                      <input
                        type=\"text\"
                        value={form.assignedTo}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            assignedTo: e.target.value,
                          }))
                        }
                        className=\"w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500\"
                      />
                    </div>
                    <div>
                      <label className=\"mb-1 block font-medium text-zinc-800\">
                        Notes (optional)
                      </label>
                      <textarea
                        rows={3}
                        value={form.notes}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            notes: e.target.value,
                          }))
                        }
                        className=\"w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500\"
                      />
                    </div>
                    <div className=\"pt-1\">
                      <button
                        type=\"submit\"
                        disabled={savingManufacturing}
                        className=\"rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70\"
                      >
                        {savingManufacturing
                          ? \"Saving…\"
                          : \"Save manufacturing schedule\"}
                      </button>
                    </div>
                  </div>
                </form>

                {selectedProduct && (
                  <div className=\"grid gap-4 text-xs md:grid-cols-2\">
                    <div className=\"space-y-3\">
                      <div className=\"rounded-md border border-zinc-200 bg-zinc-50 p-3\">
                        <div className=\"mb-1 text-[11px] font-semibold text-zinc-900\">
                          Batch properties
                        </div>
                        <div className=\"space-y-1 text-[11px] text-black\">
                          <div>
                            <span className=\"font-medium\">
                              Product:
                            </span>{\" "}
                            {selectedProduct.name}
                          </div>
                          <div>
                            <span className=\"font-medium\">
                              Planned quantity:
                            </span>{\" "}
                            {form.plannedQuantity || \"—\"}{" "}
                            {selectedProduct.unit}
                          </div>
                          <div>
                            <span className=\"font-medium\">
                              Target batch size:
                            </span>{\" "}
                            {targetBatchSize ?? \"Not set\"}{" "}
                            {selectedProduct.target_batch_unit ||
                              selectedProduct.unit}
                          </div>
                          <div>
                            <span className=\"font-medium\">
                              Number of cycles:
                            </span>{\" "}
                            {manufacturingCycles.length || \"—\"}
                          </div>
                        </div>
                      </div>

                      <div className=\"rounded-md border border-zinc-200 bg-zinc-50 p-3\">
                        <div className=\"mb-1 text-[11px] font-semibold text-zinc-900\">
                          Cycle breakdown
                        </div>
                        {manufacturingCycles.length ? (
                          <ul className=\"space-y-1 text-[11px] text-black\">
                            {manufacturingCycles.map((c) => (
                              <li key={c.index}>
                                Cycle {c.index}: {c.quantity}{" "}
                                {selectedProduct.unit}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className=\"text-[11px] text-black\">
                            Enter a planned quantity to see cycle breakdown.
                          </p>
                        )}
                      </div>
                    </div>

                    <div className=\"space-y-3\">
                      <div className=\"rounded-md border border-zinc-200 bg-zinc-50 p-3\">
                        <div className=\"mb-1 text-[11px] font-semibold text-zinc-900\">
                          Ingredients per cycle
                        </div>
                        {cycleRequirements.length && bomLinesForProduct.length ? (
                          <div className=\"max-h-48 space-y-2 overflow-y-auto\">
                            {cycleRequirements.map((cycleReqs, idx) => (
                              <div key={idx} className=\"border-t border-zinc-200 pt-2 first:border-t-0 first:pt-0\">
                                <div className=\"mb-1 text-[11px] font-medium text-zinc-900\">
                                  Cycle {cycleReqs[0]?.cycleIndex} (
                                  {manufacturingCycles.find(
                                    (c) => c.index === cycleReqs[0]?.cycleIndex,
                                  )?.quantity ?? \"?\"}{" "}
                                  {selectedProduct.unit})
                                </div>
                                <ul className=\"space-y-0.5 text-[11px] text-black\">
                                  {cycleReqs.map((req) => (
                                    <li key={req.bomLineId}>
                                      {req.ingredientName}:{" "}
                                      {req.quantity.toFixed(4)} {req.unitLabel}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className=\"text-[11px] text-black\">
                            Define BOM lines for this product to see ingredient
                            requirements per cycle. Each BOM line&apos;s
                            quantity is per 1 finished unit.
                          </p>
                        )}
                      </div>

                      <div className=\"rounded-md border border-zinc-200 bg-zinc-50 p-3\">
                        <div className=\"mb-1 text-[11px] font-semibold text-zinc-900\">
                          Total ingredient requirements
                        </div>
                        {totalRequirements.length ? (
                          <ul className=\"space-y-0.5 text-[11px] text-black\">
                            {totalRequirements.map((req) => (
                              <li key={req.ingredientId}>
                                {req.ingredientName}:{" "}
                                {req.totalQuantity.toFixed(4)} {req.unitLabel}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className=\"text-[11px] text-black\">
                            Totals will appear once a product, quantity, and BOM
                            lines are defined.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </AuthGuard>
  );
}

