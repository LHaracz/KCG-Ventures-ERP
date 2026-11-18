"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import {
  Badge,
  Chip,
  ConfirmDialog,
  Dialog,
  ErrorSummary,
  RiskBadge,
  Select,
  TextArea,
  TextField,
  UrlTabs,
  btn,
  btnDanger,
  btnPrimary,
  card,
  errorBox,
  fmtDate,
  fmtLongDate,
  infoBox,
  input,
  warnBox,
} from "@/components/growth/GrowthUi";
import {
  addTaskApi,
  fetchEmployees,
  fetchLaunch,
  fetchLaunches,
  ingredientApi,
  reorderTasksApi,
  shiftLaunchApi,
  syncLaunchApi,
  updateLaunchApi,
  updateTaskApi,
  type GrowthApiError,
} from "@/lib/growth/client";
import { LAUNCH_STATUSES, type IngredientView, type LaunchDetail, type LaunchTask } from "@/lib/growth/launches";
import { PHASES, shiftOpenTasks, type TaskPhase, type TaskStatus } from "@/lib/growth/tasks";
import { stateChip } from "@/lib/growth/plan";
import { diffDays, todayNy } from "@/lib/growth/dates";
import type { AssignableEmployee } from "@/lib/growth/employees";

type Detail = LaunchDetail & { can_create_po: boolean };
type Tab = "checklist" | "ingredients" | "notes";

export default function LaunchDetailPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
        <LaunchDetailInner />
      </Suspense>
    </AuthGuard>
  );
}

const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

function LaunchDetailInner() {
  const { user } = useSupabase();
  const { id } = useParams<{ id: string }>();
  const tabParam = useSearchParams().get("tab");
  const tab: Tab = tabParam === "ingredients" || tabParam === "notes" ? tabParam : "checklist";
  const [d, setD] = useState<Detail | null>(null);
  const [employees, setEmployees] = useState<AssignableEmployee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [shifting, setShifting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, emp] = await Promise.all([fetchLaunch(id), fetchEmployees()]);
      setD(detail);
      setEmployees(emp.employees);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    void load();
  }, [user, load]);

  /** Runs an action, shows its error, then reloads. */
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await fn();
        await load();
        return true;
      } catch (e) {
        setActionError((e as Error).message);
        return false;
      }
    },
    [load],
  );

  if (error && !d) {
    return (
      <div className="mx-auto max-w-7xl space-y-3 text-black">
        <Link href="/growth/launches" className="text-xs font-medium text-black underline">← Back to Launch Pipeline</Link>
        <p className={errorBox} role="alert">{error}</p>
      </div>
    );
  }
  if (!d) return <p className="text-xs text-black">Loading…</p>;
  const l = d.launch;
  const slip = d.plan.slipDays ?? 0;

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <Link href="/growth/launches" className="text-xs font-medium text-black underline">← Back to Launch Pipeline</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-black">{l.name}</h1>
          <p className="text-sm text-black">
            {d.product ? d.product.name : "No product yet"} · {LAUNCH_STATUSES.find((s) => s.value === l.status)?.label}
          </p>
        </div>
        <button type="button" className={btn} onClick={() => setEditing(true)}>
          Edit launch
        </button>
      </div>

      <section className={`${card} grid grid-cols-2 gap-3 text-sm md:grid-cols-5`} data-testid="launch-summary">
        <Stat label="Target launch" value={fmtLongDate(l.target_launch_date)} />
        <Stat label="Planned test batch" value={fmtLongDate(l.planned_test_batch_date)} />
        <Stat label="Earliest test batch if you order everything today" value={fmtLongDate(d.plan.earliestTestBatchDate)} testId="earliest" />
        <Stat label="Slip" value={d.plan.slipDays === null ? "—" : slip > 0 ? `${slip} day${slip === 1 ? "" : "s"}` : "None"} />
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-black">Risk</p>
          <RiskBadge risk={d.risk} />
          {d.plan.hasUnknownLeadTimes && <p className="mt-1 text-[11px]">Some lead times are unknown.</p>}
        </div>
      </section>

      {slip > 0 && (
        <div className={warnBox} role="status" data-testid="slip-banner">
          <p>
            Ingredients can&apos;t all arrive before the planned test batch: the earliest test batch is {fmtLongDate(d.plan.earliestTestBatchDate)}, {slip} day{slip === 1 ? "" : "s"} late.
          </p>
          <button type="button" className={`${btnPrimary} mt-2`} onClick={() => setShifting(true)}>
            Shift open task dates by {slip} days
          </button>
        </div>
      )}
      {actionError && <p className={errorBox} role="alert">{actionError}</p>}

      <UrlTabs
        base={`/growth/launches/${l.id}`}
        current={tab}
        tabs={[
          { key: "checklist", label: "Checklist" },
          { key: "ingredients", label: "Ingredients" },
          { key: "notes", label: "Notes" },
        ]}
      />

      {tab === "checklist" && <Checklist d={d} employees={employees} act={act} />}
      {tab === "ingredients" && <Ingredients d={d} act={act} />}
      {tab === "notes" && <Notes d={d} act={act} />}

      {editing && <EditLaunchDialog d={d} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); }} />}
      {shifting && <ShiftDialog d={d} days={slip} onClose={() => setShifting(false)} act={act} />}
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-black">{label}</p>
      <p className="font-semibold" data-testid={testId}>{value}</p>
    </div>
  );
}

// --- Checklist --------------------------------------------------------------------------------
function Checklist({ d, employees, act }: { d: Detail; employees: AssignableEmployee[]; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const today = todayNy();
  const [order, setOrder] = useState<string[]>(() => d.tasks.map((t) => t.id));
  const [dragId, setDragId] = useState<string | null>(null);
  const [editTask, setEditTask] = useState<LaunchTask | null>(null);
  const [adding, setAdding] = useState<{ title: string; phase: TaskPhase; owner: string; due: string }>({ title: "", phase: "other", owner: "", due: "" });
  const [addError, setAddError] = useState<string | null>(null);
  const ids = d.tasks.map((t) => t.id).join(",");
  // eslint-disable-next-line react-hooks/set-state-in-effect -- keep the local order in step with reloaded tasks
  useEffect(() => setOrder(d.tasks.map((t) => t.id)), [ids, d.tasks]);
  const byId = new Map(d.tasks.map((t) => [t.id, t]));
  const ordered = order.map((x) => byId.get(x)).filter((t): t is LaunchTask => !!t);

  const save = (t: LaunchTask, patch: Record<string, unknown>) => act(() => updateTaskApi(d.launch.id, t.id, patch));
  const commitOrder = (next: string[]) => {
    setOrder(next);
    void act(() => reorderTasksApi(d.launch.id, next));
  };
  const move = (taskId: string, delta: -1 | 1) => {
    const i = order.indexOf(taskId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    commitOrder(next);
  };
  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const next = order.filter((x) => x !== dragId);
    next.splice(next.indexOf(targetId), 0, dragId);
    setDragId(null);
    commitOrder(next);
  };
  const owners = [{ value: "", label: "No owner" }, ...employees.map((e) => ({ value: e.id, label: e.name }))];

  const addTask = async () => {
    setAddError(null);
    if (!adding.title.trim()) {
      setAddError("Enter a task.");
      return;
    }
    const ok = await act(() => addTaskApi(d.launch.id, { title: adding.title, phase: adding.phase, owner_account_id: adding.owner || null, due_date: adding.due || null }));
    if (ok) setAdding({ title: "", phase: adding.phase, owner: "", due: "" });
  };

  return (
    <section className="space-y-4" data-testid="checklist">
      {PHASES.map((p) => {
        const tasks = ordered.filter((t) => t.phase === p.key);
        if (tasks.length === 0) return null;
        return (
          <div key={p.key} className={card}>
            <h2 className="mb-2 text-sm font-semibold">
              {p.label} <span className="font-normal">({tasks.filter((t) => t.status === "done").length} of {tasks.length} done)</span>
            </h2>
            <ul className="space-y-1">
              {tasks.map((t) => {
                const overdue = t.status !== "done" && !!t.due_date && diffDays(t.due_date, today) > 0;
                return (
                  <li
                    key={t.id}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => drop(t.id)}
                    className={`grid grid-cols-1 items-center gap-2 rounded-md border px-2 py-1.5 text-xs md:grid-cols-[auto_1fr_10rem_9rem_8rem_auto] ${overdue ? "border-red-300 bg-red-50" : "border-zinc-200 bg-white"}`}
                    data-testid="task-row"
                    data-task-title={t.title}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Done: ${t.title}`}
                      checked={t.status === "done"}
                      disabled={!!t.auto_kind}
                      title={t.auto_kind ? "Automatic: checked off on its own" : undefined}
                      onChange={(e) => save(t, { status: e.target.checked ? "done" : "todo" })}
                      className="h-5 w-5"
                    />
                    <div>
                      <span className={`font-medium ${t.status === "done" ? "line-through" : ""}`}>{t.title}</span>{" "}
                      {t.auto_kind && <Badge tone="blue">Automatic</Badge>} {overdue && <Badge tone="red">Overdue</Badge>}
                      {t.status === "done" && t.done_by_name && <span className="ml-1 text-[11px]">Done by {t.done_by_name}</span>}
                      {t.notes && <p className="mt-0.5 whitespace-pre-line text-[11px]">{t.notes}</p>}
                    </div>
                    <select aria-label={`Owner of ${t.title}`} value={t.owner_account_id ?? ""} onChange={(e) => save(t, { owner_account_id: e.target.value || null })} className={input}>
                      {owners.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      aria-label={`Due date of ${t.title}`}
                      defaultValue={t.due_date ?? ""}
                      key={`${t.id}-${t.due_date}`}
                      onBlur={(e) => e.target.value !== (t.due_date ?? "") && save(t, { due_date: e.target.value || null })}
                      className={input}
                    />
                    <select aria-label={`Status of ${t.title}`} value={t.status} disabled={!!t.auto_kind} onChange={(e) => save(t, { status: e.target.value })} className={input}>
                      {STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <div className="flex gap-1">
                      <button type="button" className={btn} aria-label={`Move ${t.title} up`} onClick={() => move(t.id, -1)}>↑</button>
                      <button type="button" className={btn} aria-label={`Move ${t.title} down`} onClick={() => move(t.id, 1)}>↓</button>
                      <button type="button" className={btn} onClick={() => setEditTask(t)}>Edit</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {d.tasks.length === 0 && <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-black">No tasks yet. Add the first one below.</p>}
      <div className={`${card} space-y-2`}>
        <h2 className="text-sm font-semibold">Add a task</h2>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_10rem_10rem_9rem_auto]">
          <input aria-label="New task" placeholder="New task" value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} className={input} />
          <select aria-label="Phase" value={adding.phase} onChange={(e) => setAdding({ ...adding, phase: e.target.value as TaskPhase })} className={input}>
            {PHASES.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
          <select aria-label="Owner" value={adding.owner} onChange={(e) => setAdding({ ...adding, owner: e.target.value })} className={input}>
            {owners.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <input type="date" aria-label="Due date" value={adding.due} onChange={(e) => setAdding({ ...adding, due: e.target.value })} className={input} />
          <button type="button" className={btnPrimary} onClick={addTask}>Add task</button>
        </div>
        {addError && <p className="text-[11px] text-red-700">{addError}</p>}
        <p className="text-[11px]">Drag tasks (or use ↑ ↓) to reorder. Tasks marked Automatic check themselves off: the formula task when the product&apos;s latest formula is final, and the ingredients task when nothing is left to order or on its way.</p>
      </div>
      {editTask && <EditTaskDialog launchId={d.launch.id} task={editTask} onClose={() => setEditTask(null)} act={act} />}
    </section>
  );
}

function EditTaskDialog({ launchId, task, onClose, act }: { launchId: string; task: LaunchTask; onClose: () => void; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [title, setTitle] = useState(task.title);
  const [phase, setPhase] = useState<TaskPhase>(task.phase);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = async () => {
    if (await act(() => updateTaskApi(launchId, task.id, { title, phase, notes }))) onClose();
  };
  if (confirmRemove) {
    return (
      <ConfirmDialog
        title={`Remove "${task.title}"?`}
        confirmLabel="Remove task"
        busy={false}
        error={null}
        onConfirm={async () => {
          if (await act(() => updateTaskApi(launchId, task.id, { archive: true }))) onClose();
        }}
        onClose={() => setConfirmRemove(false)}
      >
        <p>The task is archived and leaves the checklist.</p>
      </ConfirmDialog>
    );
  }
  return (
    <Dialog title="Edit task" onClose={onClose}>
      <div className="space-y-3 text-black">
        <TextField name="task-title" label="Task" value={title} onChange={setTitle} required />
        <Select name="task-phase" label="Phase" value={phase} onChange={(v) => setPhase(v as TaskPhase)} options={PHASES.map((p) => ({ value: p.key, label: p.label }))} />
        <TextArea name="task-notes" label="Notes" value={notes} onChange={setNotes} />
        <div className="flex justify-between gap-2">
          {!task.auto_kind ? (
            <button type="button" className={btnDanger} onClick={() => setConfirmRemove(true)}>Remove</button>
          ) : (
            <span className="text-[11px]">Automatic tasks can&apos;t be removed.</span>
          )}
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={onClose}>Cancel</button>
            <button type="button" className={btnPrimary} onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// --- Ingredients ------------------------------------------------------------------------------
type OrderForm = { row: IngredientView; kind: "ordered" | "arrived" } | null;

function Ingredients({ d, act }: { d: Detail; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [form, setForm] = useState<OrderForm>(null);
  const [poOpen, setPoOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const units = d.launch.test_batch_units;
  const rows = d.ingredients;
  const planned = rows.filter((r) => r.in_formula);
  const toOrder = planned.filter((r) => r.plan && ["to_order", "no_lead_time", "ordered_short"].includes(r.plan.state) && Number(r.plan.shortfall) > 0);

  return (
    <section className="space-y-3" data-testid="ingredients">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          Formula: <span className="font-medium">{d.formula ? d.formula.label : d.product ? "No formula yet" : "Choose a product first"}</span>
          {" · "}Test batch: <span className="font-medium">{units ? `${Number(units)} units` : "size not set"}</span>
        </p>
        <div className="flex gap-2">
          {d.can_create_po && (
            <button type="button" className={btn} onClick={() => setPoOpen(true)} disabled={toOrder.length === 0}>
              Create PO for ingredients to order
            </button>
          )}
          <button
            type="button"
            className={btnPrimary}
            disabled={syncing || !d.formula}
            onClick={async () => {
              setSyncing(true);
              await act(() => syncLaunchApi(d.launch.id));
              setSyncing(false);
            }}
          >
            {syncing ? "Syncing…" : "Sync from formula"}
          </button>
        </div>
      </div>
      {!units && <p className={warnBox}>Set the test batch size (Edit launch) to work out how much of each ingredient is needed.</p>}
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-black">No ingredients yet. Use Sync from formula.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
          <table className="min-w-full text-left text-xs text-black" data-testid="ingredients-table">
            <thead className="bg-zinc-50">
              <tr>
                {["Ingredient", "Needed", "On hand", "In transit", "Shortfall", "Supplier", "Order by", "Expected arrival", "Status", ""].map((h) => (
                  <th key={h || "actions"} className="px-2 py-2 font-semibold">{h || <span className="sr-only">Actions</span>}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = r.plan;
                const chip = p ? stateChip(p) : null;
                const late = p?.state === "to_order" && p.lateByDays > 0;
                const unit = r.material?.unit ?? "";
                return (
                  <tr key={r.id} className={`border-t border-zinc-100 align-top ${late ? "bg-red-50" : !r.in_formula ? "bg-zinc-50" : ""}`} data-testid="ingredient-row" data-name={r.material?.name}>
                    <td className="px-2 py-1.5">
                      <span className="font-medium">{r.material?.name ?? "Deleted raw material"}</span>
                      {r.material?.line_type === "packaging" && <span className="ml-1"><Badge>Packaging</Badge></span>}
                      {!r.in_formula && <div><Badge tone="amber">No longer in formula</Badge></div>}
                    </td>
                    <td className="px-2 py-1.5">{p ? `${p.needed} ${unit}` : "—"}</td>
                    <td className="px-2 py-1.5">{p ? `${p.onHand} ${unit}` : "—"}</td>
                    <td className="px-2 py-1.5">{p && Number(p.inTransit) > 0 ? `${p.inTransit} ${unit}` : "—"}</td>
                    <td className="px-2 py-1.5 font-medium">{p ? `${p.shortfall} ${unit}` : "—"}</td>
                    <td className="px-2 py-1.5">
                      <select
                        aria-label={`Supplier for ${r.material?.name}`}
                        value={r.supplier_link_id ?? ""}
                        onChange={(e) => act(() => ingredientApi(d.launch.id, r.id, { action: "supplier", supplier_link_id: e.target.value || null }))}
                        className={`${input} w-40`}
                      >
                        <option value="">No supplier</option>
                        {r.listings.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.is_preferred ? "★ " : ""}
                            {x.supplier_name} · {x.lead_time_days === null ? "no lead time" : `${x.lead_time_days} days`}
                          </option>
                        ))}
                      </select>
                      {r.supplier && r.supplier.lead_time_days === null && <div className="mt-0.5"><Badge tone="amber">No lead time</Badge></div>}
                      {r.listings.length === 0 && <div className="mt-0.5 text-[11px]">No supplier listings in Procurement.</div>}
                    </td>
                    <td className={`px-2 py-1.5 ${late ? "font-semibold text-red-700" : ""}`}>
                      {p?.orderBy ? fmtDate(p.orderBy) : "—"}
                      {late && <div>{p!.lateByDays} days late</div>}
                    </td>
                    <td className="px-2 py-1.5">
                      {p?.expectedArrivalDate ? fmtDate(p.expectedArrivalDate) : p?.arrivalIfOrderedToday ? <span>{fmtDate(p.arrivalIfOrderedToday)} if ordered today</span> : "—"}
                      {r.status === "arrived" && r.arrived_at && <div>Arrived {fmtDate(r.arrived_at)}</div>}
                    </td>
                    <td className="px-2 py-1.5">
                      {chip && <Chip tone={chip.tone}>{chip.label}</Chip>}
                      {r.arrived_source === "receiving_log" && r.status === "arrived" && <div className="mt-0.5"><Badge tone="blue">From Receiving Log</Badge></div>}
                      {r.po_reference && <div className="mt-0.5 text-[11px]">PO {r.po_reference}</div>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {(r.status === "pending" || r.status === "arrived") && r.in_formula && (
                          <button type="button" className={btn} onClick={() => setForm({ row: r, kind: "ordered" })}>Mark ordered</button>
                        )}
                        {r.status === "ordered" && <button type="button" className={btn} onClick={() => setForm({ row: r, kind: "arrived" })}>Mark arrived</button>}
                        {r.status !== "pending" && <button type="button" className={btn} onClick={() => act(() => ingredientApi(d.launch.id, r.id, { action: "undo" }))}>Undo</button>}
                        {r.status === "pending" && <button type="button" className={btn} onClick={() => act(() => ingredientApi(d.launch.id, r.id, { action: "skip" }))}>Skip</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px]">
        Needed = per-unit formula quantity × test batch units, in each material&apos;s own unit. Order by = planned test batch date − lead time − {d.launch.buffer_days} buffer day{d.launch.buffer_days === 1 ? "" : "s"}.
        Ordered rows turn Arrived on their own when the Receiving Log has an entry for the material on or after the order date.
      </p>
      {form && <IngredientForm d={d} form={form} onClose={() => setForm(null)} act={act} />}
      {poOpen && <CreatePoDialog d={d} rows={toOrder} onClose={() => setPoOpen(false)} act={act} />}
    </section>
  );
}

function IngredientForm({ d, form, onClose, act }: { d: Detail; form: NonNullable<OrderForm>; onClose: () => void; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const today = todayNy();
  const r = form.row;
  const [date, setDate] = useState(today);
  const [qty, setQty] = useState(r.plan && Number(r.plan.shortfall) > 0 ? r.plan.shortfall : "");
  const [po, setPo] = useState("");
  const [expected, setExpected] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await ingredientApi(
        d.launch.id,
        r.id,
        form.kind === "ordered" ? { action: "ordered", ordered_at: date, qty_ordered: qty, po_reference: po, expected_arrival: expected } : { action: "arrived", arrived_at: date },
      );
      await act(async () => undefined);
      onClose();
    } catch (e) {
      setErrors((e as GrowthApiError).fields ?? { form: (e as Error).message });
      setBusy(false);
    }
  };
  return (
    <Dialog title={`${form.kind === "ordered" ? "Mark ordered" : "Mark arrived"}: ${r.material?.name ?? ""}`} onClose={onClose}>
      <div className="space-y-3 text-black">
        <ErrorSummary message={errors.form ?? null} errors={{}} />
        <TextField name="ing-date" label={form.kind === "ordered" ? "Order date" : "Arrival date"} type="date" value={date} onChange={setDate} required error={errors.ordered_at ?? errors.arrived_at} />
        {form.kind === "ordered" && (
          <>
            <TextField name="ing-qty" label={`Quantity ordered (${r.material?.unit ?? ""})`} value={qty} onChange={setQty} inputMode="decimal" required error={errors.qty_ordered} />
            <TextField name="ing-po" label="PO reference (optional)" value={po} onChange={setPo} error={errors.po_reference} />
            <TextField name="ing-expected" label="Expected arrival (optional override)" type="date" value={expected} onChange={setExpected} error={errors.expected_arrival} hint="Leave blank to use the order date plus the supplier's lead time." />
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </Dialog>
  );
}

function CreatePoDialog({ d, rows, onClose, act }: { d: Detail; rows: IngredientView[]; onClose: () => void; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const groups = useMemo(() => {
    const m = new Map<string, { supplierId: string; name: string; rows: IngredientView[] }>();
    for (const r of rows) {
      if (!r.supplier) continue;
      const g = m.get(r.supplier.supplier_id) ?? { supplierId: r.supplier.supplier_id, name: r.supplier.supplier_name, rows: [] };
      g.rows.push(r);
      m.set(r.supplier.supplier_id, g);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);
  const noSupplier = rows.filter((r) => !r.supplier);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(rows.map((r) => r.id)));
  const [marking, setMarking] = useState<string | null>(null);
  const today = todayNy();
  const toggle = (id: string) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const markGroupOrdered = async (g: (typeof groups)[number]) => {
    setMarking(g.supplierId);
    for (const r of g.rows.filter((x) => checked.has(x.id))) {
      await ingredientApi(d.launch.id, r.id, { action: "ordered", ordered_at: today, qty_ordered: r.plan?.shortfall ?? "0" }).catch(() => undefined);
    }
    await act(async () => undefined);
    setMarking(null);
  };
  return (
    <Dialog title="Create PO for ingredients to order" onClose={onClose} wide>
      <div className="space-y-3 text-sm text-black">
        <p className={infoBox}>One Purchase Order per supplier. Quantities start at each shortfall and can be changed on the PO form. Nothing is saved and no PO number is used until you save the PO there. Marking the rows ordered is a separate step.</p>
        {groups.length === 0 && <p>No ingredient with a shortfall has a supplier yet. Choose suppliers on the Ingredients tab.</p>}
        {groups.map((g) => {
          const ids = g.rows.filter((r) => checked.has(r.id)).map((r) => r.id);
          return (
            <div key={g.supplierId} className="rounded-md border border-zinc-200 p-3" data-testid="po-group">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">{g.name}</h3>
                <div className="flex gap-2">
                  <button type="button" className={btn} disabled={ids.length === 0 || marking === g.supplierId} onClick={() => markGroupOrdered(g)}>
                    {marking === g.supplierId ? "Marking…" : "Mark ordered"}
                  </button>
                  {ids.length > 0 ? (
                    <Link
                      className={btnPrimary}
                      href={`/inventory/purchase-orders/new?supplier=${encodeURIComponent(g.supplierId)}&launch=${encodeURIComponent(d.launch.id)}&rows=${ids.map(encodeURIComponent).join(",")}`}
                    >
                      Open PO form
                    </Link>
                  ) : (
                    <span className={`${btnPrimary} opacity-50`}>Open PO form</span>
                  )}
                </div>
              </div>
              <ul className="space-y-1">
                {g.rows.map((r) => (
                  <li key={r.id} className="flex items-center gap-2">
                    <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Order ${r.material?.name}`} className="h-4 w-4" />
                    <span className="flex-1">{r.material?.name}</span>
                    <span>{r.plan?.shortfall} {r.material?.unit}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {noSupplier.length > 0 && <p className={warnBox}>No supplier chosen for: {noSupplier.map((r) => r.material?.name).join(", ")}.</p>}
        <div className="flex justify-end">
          <button type="button" className={btn} onClick={onClose}>Close</button>
        </div>
      </div>
    </Dialog>
  );
}

// --- Notes ----------------------------------------------------------------------------------
function Notes({ d, act }: { d: Detail; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [notes, setNotes] = useState(d.launch.notes ?? "");
  const [saved, setSaved] = useState(false);
  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className={`${card} space-y-2`}>
        <TextArea name="launch-notes" label="Notes" value={notes} onChange={(v) => { setNotes(v); setSaved(false); }} rows={10} />
        <div className="flex items-center justify-end gap-2">
          {saved && <span className="text-xs">Saved.</span>}
          <button type="button" className={btnPrimary} onClick={async () => setSaved(await act(() => updateLaunchApi(d.launch.id, { notes })))}>Save notes</button>
        </div>
      </div>
      <div className={card}>
        <h2 className="mb-2 text-sm font-semibold">Activity</h2>
        {d.events.length === 0 ? (
          <p className="text-xs">Nothing yet.</p>
        ) : (
          <ul className="space-y-1 text-xs" data-testid="launch-events">
            {d.events.map((e) => (
              <li key={e.id}>
                <span className="font-medium">{new Date(e.created_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}</span>
                {" · "}
                {e.actor_name ?? "Unknown"}: {e.detail ?? e.event.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// --- Dialogs ----------------------------------------------------------------------------------
function EditLaunchDialog({ d, onClose, onSaved }: { d: Detail; onClose: () => void; onSaved: () => void }) {
  const l = d.launch;
  const { user } = useSupabase();
  const [products, setProducts] = useState<Array<{ id: string; name: string; in_development: boolean }>>([]);
  useEffect(() => {
    if (!user) return;
    void fetchLaunches().then((r) => setProducts(r.products)).catch(() => setProducts([]));
  }, [user]);
  const [v, setV] = useState({
    name: l.name,
    formulation_product_id: l.formulation_product_id ?? "",
    status: l.status as string,
    target_launch_date: l.target_launch_date,
    planned_test_batch_date: l.planned_test_batch_date ?? "",
    test_batch_units: l.test_batch_units === null ? "" : String(Number(l.test_batch_units)),
    buffer_days: String(l.buffer_days),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const save = async () => {
    try {
      await updateLaunchApi(l.id, { ...v, formulation_product_id: v.formulation_product_id || null });
      onSaved();
    } catch (e) {
      setMessage((e as Error).message);
      setErrors((e as GrowthApiError).fields ?? {});
    }
  };
  return (
    <Dialog title="Edit launch" onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <TextField name="edit-name" label="Launch name" value={v.name} onChange={set("name")} required error={errors.name} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            name="edit-product"
            label="Product"
            value={v.formulation_product_id}
            onChange={set("formulation_product_id")}
            options={[{ value: "", label: "None yet" }, ...(products.length ? products : d.product ? [{ id: d.product.id, name: d.product.name, in_development: false }] : []).map((p) => ({ value: p.id, label: p.name }))]}
            error={errors.formulation_product_id}
          />
          <Select name="edit-status" label="Status" value={v.status} onChange={set("status")} options={LAUNCH_STATUSES} />
          <TextField name="edit-target" label="Target launch date" type="date" value={v.target_launch_date} onChange={set("target_launch_date")} required error={errors.target_launch_date} />
          <TextField name="edit-test-batch" label="Planned test batch date" type="date" value={v.planned_test_batch_date} onChange={set("planned_test_batch_date")} error={errors.planned_test_batch_date} />
          <TextField name="edit-units" label="Test batch size (units)" value={v.test_batch_units} onChange={set("test_batch_units")} inputMode="decimal" error={errors.test_batch_units} />
          <TextField name="edit-buffer" label="Buffer days" value={v.buffer_days} onChange={set("buffer_days")} inputMode="numeric" error={errors.buffer_days} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>Cancel</button>
          <button type="button" className={btnPrimary} onClick={save}>Save</button>
        </div>
      </div>
    </Dialog>
  );
}

function ShiftDialog({ d, days, onClose, act }: { d: Detail; days: number; onClose: () => void; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [alsoBatch, setAlsoBatch] = useState(true);
  const preview = shiftOpenTasks(d.tasks, days).map((t, i) => ({ t, before: d.tasks[i].due_date })).filter((x) => x.before !== x.t.due_date);
  return (
    <ConfirmDialog
      title={`Shift open task dates by ${days} days?`}
      confirmLabel="Shift dates"
      busy={false}
      error={null}
      onConfirm={async () => {
        if (await act(() => shiftLaunchApi(d.launch.id, { days, ...(alsoBatch ? { planned_test_batch_date: d.plan.earliestTestBatchDate } : {}) }))) onClose();
      }}
      onClose={onClose}
    >
      <p>{preview.length} open task{preview.length === 1 ? "" : "s"} move. Done tasks and tasks without a date stay as they are.</p>
      <ul className="max-h-48 overflow-y-auto text-xs">
        {preview.map(({ t, before }) => (
          <li key={t.id}>
            {t.title}: {fmtDate(before)} → {fmtDate(t.due_date)}
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={alsoBatch} onChange={(e) => setAlsoBatch(e.target.checked)} />
        Also move the planned test batch date to {fmtLongDate(d.plan.earliestTestBatchDate)}
      </label>
    </ConfirmDialog>
  );
}
