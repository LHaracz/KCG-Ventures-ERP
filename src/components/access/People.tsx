"use client";

import { useEffect, useState } from "react";
import { useAccess } from "@/components/access/AccessProvider";
import { apiFetch } from "@/lib/access/clientFetch";

/**
 * "The person doing this right now": the signed-in employee, read-only. The
 * server stores the name and account from the session and ignores anything
 * the browser sends.
 */
export function YouName({ label, className = "" }: { label: string; className?: string }) {
  const { me } = useAccess();
  return (
    <div className={className}>
      <span className="mb-1 block text-xs font-medium text-black">{label}</span>
      <span className="block rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-black" data-testid="you-name">
        {me?.fullName ? `${me.fullName} (you)` : "—"}
      </span>
    </div>
  );
}

/** Names of active employee accounts (for fields that name someone else). */
export function useActiveEmployeeNames(): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ employees: Array<{ fullName: string }> }>("/api/account/employees")
      .then((r) => !cancelled && setNames(r.employees.map((e) => e.fullName)))
      .catch(() => !cancelled && setNames([]));
    return () => {
      cancelled = true;
    };
  }, []);
  return names;
}

/**
 * A field naming another person. Offers the active employee accounts; with
 * `freeText` (training trainee) any name can be typed. Stores the name text.
 * An existing value that isn't in the list is kept and shown as it is.
 */
export function EmployeeNameField({
  id,
  value,
  onChange,
  freeText = false,
  className = "",
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  freeText?: boolean;
  className?: string;
}) {
  const names = useActiveEmployeeNames();
  if (freeText) {
    const listId = `${id ?? "employee"}-names`;
    return (
      <>
        <input id={id} list={listId} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Type a name or pick an employee" className={className} />
        <datalist id={listId}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </>
    );
  }
  const options = value && !names.includes(value) ? [value, ...names] : names;
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">Select…</option>
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}
