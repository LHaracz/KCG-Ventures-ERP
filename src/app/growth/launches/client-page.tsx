"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { Checkbox, Dialog, ErrorSummary, RiskBadge, Select, TextField, UrlTabs, btn, btnPrimary, errorBox, fmtDate, input } from "@/components/growth/GrowthUi";
import { createLaunchApi, fetchLaunches, GrowthApiError, type LaunchList } from "@/lib/growth/client";
import { LAUNCH_STATUSES, RISK_ORDER } from "@/lib/growth/launches";
import { addDays, isIsoDate } from "@/lib/growth/dates";

export default function LaunchesPage() {
  return (
    <AuthGuard>
      <Suspense fallback={<p className="text-xs text-black">Loading…</p>}>
        <LaunchesInner />
      </Suspense>
    </AuthGuard>
  );
}

const statusLabel = (s: string) => LAUNCH_STATUSES.find((x) => x.value === s)?.label ?? s;

function LaunchesInner() {
  const { user } = useSupabase();
  const tab = useSearchParams().get("tab") === "mine" ? "mine" : "launches";
  const [data, setData] = useState<LaunchList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchLaunches();
      setData(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    void load();
  }, [user, load]);

  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => (!status ? r.launch.status !== "cancelled" || status === "cancelled" : r.launch.status === status) && (!mineOnly || r.mine)),
    [data, status, mineOnly],
  );

  return (
    <div className="mx-auto max-w-7xl space-y-4 text-black">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-black">Launch Pipeline</h1>
          <p className="text-sm text-black">A dated checklist for every new product, and when to order ingredients so the test batch isn&apos;t waiting on them.</p>
        </div>
        <button type="button" className={btnPrimary} onClick={() => setCreating(true)} disabled={!data}>
          New launch
        </button>
      </div>
      <UrlTabs base="/growth/launches" current={tab} tabs={[{ key: "launches", label: "Launches" }, { key: "mine", label: "My tasks" }]} />
      {error && (
        <p className={errorBox} role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="text-xs text-black">Loading…</p>}

      {data && tab === "launches" && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="launch-status" className="mb-1 block text-xs font-medium text-black">
                Status
              </label>
              <select id="launch-status" value={status} onChange={(e) => setStatus(e.target.value)} className={`${input} w-44`}>
                <option value="">All but cancelled</option>
                {LAUNCH_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <Checkbox name="mine" label="Mine (I own a task)" checked={mineOnly} onChange={setMineOnly} />
          </div>
          {rows.length === 0 ? (
            <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-black">
              {data.rows.length === 0 ? "No launches yet. Start one with New launch." : "No launches match."}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
              <table className="min-w-full text-left text-xs text-black" data-testid="launches-table">
                <thead className="bg-zinc-50">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Launch</th>
                    <th className="px-3 py-2 font-semibold">Product</th>
                    <th className="px-3 py-2 font-semibold">Target launch</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">Progress</th>
                    <th className="px-3 py-2 font-semibold">Next task due</th>
                    <th className="px-3 py-2 font-semibold">Earliest test batch</th>
                    <th className="px-3 py-2 font-semibold">Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.launch.id} className="border-t border-zinc-100 align-top">
                      <td className="px-3 py-2">
                        <Link href={`/growth/launches/${r.launch.id}`} className="font-medium text-black underline">
                          {r.launch.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{r.product_name ?? "—"}</td>
                      <td className="px-3 py-2">{fmtDate(r.launch.target_launch_date)}</td>
                      <td className="px-3 py-2">{statusLabel(r.launch.status)}</td>
                      <td className="px-3 py-2">
                        {r.done} of {r.total}
                      </td>
                      <td className="px-3 py-2">{r.next_task ? `${r.next_task.title} (${fmtDate(r.next_task.due_date)})` : "—"}</td>
                      <td className="px-3 py-2">
                        {fmtDate(r.earliest_test_batch_date)}
                        {r.slip_days ? <span className="ml-1 font-medium text-red-700">+{r.slip_days} days</span> : null}
                      </td>
                      <td className="px-3 py-2">
                        <RiskBadge risk={r.risk} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-black">Sorted by target launch date. Risk: late when an open task is past due; at risk when the test batch would slip or a lead time is unknown.</p>
        </section>
      )}

      {data && tab === "mine" && (
        <section className="space-y-2">
          {data.myTasks.length === 0 ? (
            <p className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-black">You have no open launch tasks.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white">
              {data.myTasks.map((t) => (
                <li key={t.id} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm ${t.overdue ? "bg-red-50" : ""}`}>
                  <span>
                    <span className="font-medium">{t.title}</span> · <Link href={`/growth/launches/${t.launch_id}`} className="underline">{t.launch_name}</Link>
                  </span>
                  <span className={t.overdue ? "font-medium text-red-700" : ""}>{t.due_date ? `Due ${fmtDate(t.due_date)}${t.overdue ? " (overdue)" : ""}` : "No due date"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {creating && data && <NewLaunchDialog data={data} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewLaunchDialog({ data, onClose }: { data: LaunchList; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [product, setProduct] = useState("");
  const [target, setTarget] = useState("");
  const [testBatch, setTestBatch] = useState("");
  const [testBatchTouched, setTestBatchTouched] = useState(false);
  const [units, setUnits] = useState("");
  const [buffer, setBuffer] = useState("2");
  const [startFrom, setStartFrom] = useState<"default" | "duplicate" | "blank">("default");
  const [dupFrom, setDupFrom] = useState(data.rows[0]?.launch.id ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setTargetDate = (v: string) => {
    setTarget(v);
    if (!testBatchTouched && isIsoDate(v)) setTestBatch(addDays(v, -28));
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await createLaunchApi({
        launch: { name, formulation_product_id: product || null, target_launch_date: target, planned_test_batch_date: testBatch, test_batch_units: units, buffer_days: buffer },
        start_from: startFrom,
        duplicate_from_id: startFrom === "duplicate" ? dupFrom : undefined,
      });
      router.push(`/growth/launches/${res.launch.id}`);
    } catch (e) {
      const err = e as GrowthApiError;
      setMessage(err.message);
      setErrors(err.fields ?? {});
      setBusy(false);
    }
  };

  return (
    <Dialog title="New launch" onClose={onClose} wide>
      <div className="space-y-3 text-black">
        <ErrorSummary message={message} errors={errors} />
        <TextField name="launch-name" label="Launch name" value={name} onChange={setName} required error={errors.name} />
        <Select
          name="launch-product"
          label="Product"
          value={product}
          onChange={setProduct}
          options={[{ value: "", label: "None yet" }, ...data.products.map((p) => ({ value: p.id, label: p.in_development ? `${p.name} (in development)` : p.name }))]}
          error={errors.formulation_product_id}
          hint="Any Formulation product, including ones still in development. Its formula drives the ingredient planner."
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField name="launch-target" label="Target launch date" type="date" value={target} onChange={setTargetDate} required error={errors.target_launch_date} />
          <TextField
            name="launch-test-batch"
            label="Planned test batch date"
            type="date"
            value={testBatch}
            onChange={(v) => {
              setTestBatchTouched(true);
              setTestBatch(v);
            }}
            error={errors.planned_test_batch_date}
            hint="Defaults to 28 days before the target."
          />
          <TextField name="launch-units" label="Test batch size (units)" value={units} onChange={setUnits} inputMode="decimal" error={errors.test_batch_units} hint="Needed for ingredient planning." />
          <TextField name="launch-buffer" label="Buffer days" value={buffer} onChange={setBuffer} inputMode="numeric" error={errors.buffer_days} hint="Extra days between an ingredient arriving and the test batch (0 to 30)." />
        </div>
        <fieldset className="space-y-1">
          <legend className="text-xs font-semibold text-black">Start from</legend>
          {(
            [
              ["default", "Default checklist"],
              ["duplicate", "Duplicate another launch (dates shift to the new target; done states and owners are cleared)"],
              ["blank", "Blank"],
            ] as const
          ).map(([v, l]) => (
            <label key={v} className="flex items-center gap-2 text-sm text-black">
              <input type="radio" name="start-from" checked={startFrom === v} onChange={() => setStartFrom(v)} disabled={v === "duplicate" && data.rows.length === 0} />
              {l}
            </label>
          ))}
          {startFrom === "duplicate" && (
            <select aria-label="Launch to duplicate" value={dupFrom} onChange={(e) => setDupFrom(e.target.value)} className={input}>
              {[...data.rows].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.launch.name.localeCompare(b.launch.name)).map((r) => (
                <option key={r.launch.id} value={r.launch.id}>
                  {r.launch.name}
                </option>
              ))}
            </select>
          )}
        </fieldset>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} onClick={save} disabled={busy}>
            {busy ? "Creating…" : "Create launch"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
