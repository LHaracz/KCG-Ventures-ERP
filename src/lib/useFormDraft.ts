"use client";

/**
 * Draft saving for forms. While the user types, the form's field values are
 * saved to localStorage (about every half second) under a key made from the
 * signed-in user's id and the form. On the next load a draft younger than
 * 7 days is restored, and the form shows "Restored your unsaved draft from
 * {time}." with a Discard button. Drafts are cleared after a successful
 * submit, on Discard and on sign-out. Files and documents are never stored
 * (only a flag that some were attached). If storage is blocked or full the
 * form keeps working; nothing here ever throws.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const DRAFT_PREFIX = "kcg.draft:";
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export type StoredDraft<T> = { v: 1; savedAt: string; values: T; hadFiles: boolean };

/** The storage key for a user's form ("kcg.draft:{userId}:{formKey}"). */
export const draftKey = (userId: string, formKey: string) => `${DRAFT_PREFIX}${userId}:${formKey}`;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Never stores a File or Blob, even nested. */
function stripFiles(value: unknown): unknown {
  if (typeof File !== "undefined" && value instanceof File) return undefined;
  if (typeof Blob !== "undefined" && value instanceof Blob) return undefined;
  if (Array.isArray(value)) return value.map(stripFiles).filter((x) => x !== undefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = stripFiles(v);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return value;
}

export function writeDraft<T>(key: string, values: T, hadFiles = false, now = new Date()): boolean {
  const s = storage();
  if (!s) return false;
  try {
    const d: StoredDraft<unknown> = { v: 1, savedAt: now.toISOString(), values: stripFiles(values), hadFiles };
    s.setItem(key, JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

export function readDraft<T>(key: string, now = new Date()): StoredDraft<T> | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as StoredDraft<T>;
    if (d?.v !== 1 || !d.savedAt || now.getTime() - new Date(d.savedAt).getTime() > DRAFT_MAX_AGE_MS) {
      s.removeItem(key);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function clearDraft(key: string) {
  try {
    storage()?.removeItem(key);
  } catch {
    // Storage blocked: nothing to clear.
  }
}

/** Removes every saved draft (on sign-out). */
export function clearAllDrafts() {
  const s = storage();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(DRAFT_PREFIX)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    // Storage blocked: nothing to clear.
  }
}

/**
 * useFormDraft(key, state, …). `key` is null until the user and the form's
 * data are ready; then any saved draft is passed to `onRestore` once.
 * `dirty` says whether the form differs from its starting values (only
 * dirty forms are saved, and only they ask before the tab closes).
 */
export function useFormDraft<T>(
  key: string | null,
  state: T,
  opts: { dirty: boolean; hasFiles?: boolean; onRestore: (values: T) => void },
) {
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const [hadFiles, setHadFiles] = useState(false);
  const restoredFor = useRef<string | null>(null);
  const onRestore = useRef(opts.onRestore);
  const paused = useRef(false);
  const stopped = useRef(false);
  useEffect(() => {
    onRestore.current = opts.onRestore;
  });

  // Restore once per key.
  useEffect(() => {
    if (!key || restoredFor.current === key) return;
    restoredFor.current = key;
    const d = readDraft<T>(key);
    if (!d) return;
    paused.current = true;
    onRestore.current(d.values);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- show the restored banner once the draft is applied
    setRestoredAt(d.savedAt);
    setHadFiles(d.hadFiles);
  }, [key]);

  // Save (debounced) while the form is dirty.
  const json = JSON.stringify(stripFiles(state));
  useEffect(() => {
    if (!key || restoredFor.current !== key) return;
    if (paused.current) {
      // The first change after a restore is the restore itself.
      paused.current = false;
      return;
    }
    if (!opts.dirty || stopped.current) return;
    const t = setTimeout(() => writeDraft(key, JSON.parse(json) as T, !!opts.hasFiles), 500);
    return () => clearTimeout(t);
  }, [key, json, opts.dirty, opts.hasFiles]);

  // Ask before closing or reloading a dirty form.
  useEffect(() => {
    if (!opts.dirty || stopped.current) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (stopped.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [opts.dirty]);

  const clear = useCallback(() => {
    if (key) clearDraft(key);
    setRestoredAt(null);
    setHadFiles(false);
  }, [key]);

  /** After a successful submit: clears the draft and stops saving (the form is leaving). */
  const finish = useCallback(() => {
    stopped.current = true;
    if (key) clearDraft(key);
  }, [key]);

  return { restoredAt, hadFiles, clear, finish };
}
