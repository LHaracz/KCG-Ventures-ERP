// @vitest-environment jsdom
// Draft saving (useFormDraft): saved and restored, cleared on submit and on
// Discard, expires after 7 days, never stores files, survives blocked
// storage. And the focus fix: visibilitychange, focus and a same-user
// SIGNED_IN / TOKEN_REFRESHED event keep the same user object, so a form
// that reloads when the user changes keeps its typed values. Invented data.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const auth = vi.hoisted(() => ({
  listeners: [] as Array<(event: string, session: { user: { id: string } } | null) => void>,
}));
vi.mock("@/lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: { id: "u1", email: "person@example.test" } } }),
      onAuthStateChange: (cb: (event: string, session: { user: { id: string } } | null) => void) => {
        auth.listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
    },
  },
}));

import { DRAFT_MAX_AGE_MS, clearAllDrafts, draftKey, readDraft, useFormDraft, writeDraft } from "@/lib/useFormDraft";
import { SupabaseProvider, useSupabase } from "@/components/InstantProvider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  auth.listeners = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const KEY = draftKey("u1", "test:new");
const handles: { finish?: () => void; clear?: () => void } = {};
function DraftForm({ withFile = false }: { withFile?: boolean }) {
  const [name, setName] = useState("");
  const state = withFile ? { name, file: new File(["x"], "doc.pdf") } : { name };
  const d = useFormDraft<{ name: string }>(KEY, state as { name: string }, { dirty: name !== "", hasFiles: withFile, onRestore: (v) => setName(v.name) });
  useEffect(() => {
    handles.finish = d.finish;
    handles.clear = d.clear;
  });
  return createElement(
    "div",
    null,
    d.restoredAt ? createElement("p", { "data-testid": "banner" }, `Restored${d.hadFiles ? " Re-attach your documents." : ""}`) : null,
    createElement("input", { "data-testid": "name", value: name, onChange: (e: { target: { value: string } }) => setName(e.target.value) }),
  );
}

describe("useFormDraft", () => {
  it("saves while typing (debounced), restores on the next load, and Discard clears it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => root.render(createElement(DraftForm)));
    await type(host.querySelector<HTMLInputElement>('[data-testid="name"]')!, "Value A");
    expect(window.localStorage.getItem(KEY)).toBeNull();
    await act(async () => vi.advanceTimersByTime(600));
    expect(readDraft<{ name: string }>(KEY)?.values).toEqual({ name: "Value A" });
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(DraftForm)));
    await flush();
    expect(host.querySelector<HTMLInputElement>('[data-testid="name"]')!.value).toBe("Value A");
    expect(host.querySelector('[data-testid="banner"]')).toBeTruthy();
    await act(async () => handles.clear!());
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(host.querySelector('[data-testid="banner"]')).toBeNull();
  });

  it("a successful submit clears the draft and stops saving", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => root.render(createElement(DraftForm)));
    await type(host.querySelector<HTMLInputElement>('[data-testid="name"]')!, "Value B");
    await act(async () => vi.advanceTimersByTime(600));
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
    await act(async () => handles.finish!());
    expect(window.localStorage.getItem(KEY)).toBeNull();
    await type(host.querySelector<HTMLInputElement>('[data-testid="name"]')!, "Value C");
    await act(async () => vi.advanceTimersByTime(600));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("expires after 7 days, never stores files, and clearAllDrafts removes every draft", async () => {
    const old = new Date(Date.now() - DRAFT_MAX_AGE_MS - 1000);
    writeDraft(KEY, { name: "Old" }, false, old);
    expect(readDraft(KEY)).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    writeDraft(KEY, { name: "Kept", file: new File(["x"], "doc.pdf"), list: [new File(["y"], "b.pdf"), "text"] }, true);
    expect(readDraft(KEY)).toMatchObject({ values: { name: "Kept", list: ["text"] }, hadFiles: true });
    expect(JSON.stringify(readDraft(KEY))).not.toContain("doc.pdf");
    writeDraft(draftKey("u1", "other"), { a: 1 });
    window.localStorage.setItem("unrelated", "1");
    clearAllDrafts();
    expect([window.localStorage.getItem(KEY), window.localStorage.getItem(draftKey("u1", "other")), window.localStorage.getItem("unrelated")]).toEqual([null, null, "1"]);
  });

  it("restoring a draft that had files asks to re-attach them", async () => {
    writeDraft(KEY, { name: "With files" }, true);
    await act(async () => root.render(createElement(DraftForm, { withFile: true })));
    await flush();
    expect(host.querySelector('[data-testid="banner"]')?.textContent).toContain("Re-attach your documents.");
  });

  it("blocked storage never breaks the form", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(writeDraft(KEY, { name: "x" })).toBe(false);
    spy.mockRestore();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readDraft(KEY)).toBeNull();
    get.mockRestore();
  });
});

describe("tab focus never resets a form", () => {
  /** Like the log entry page: reloads (and resets) whenever the user object changes. */
  function ProbeForm() {
    const { user } = useSupabase();
    const [value, setValue] = useState("");
    const [loads, setLoads] = useState(0);
    useEffect(() => {
      if (!user) return;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mimics a form that reloads on user change
      setValue("");
      setLoads((n) => n + 1);
    }, [user]);
    return createElement(
      "div",
      null,
      createElement("input", { "data-testid": "probe", value, onChange: (e: { target: { value: string } }) => setValue(e.target.value) }),
      createElement("span", { "data-testid": "loads" }, String(loads)),
    );
  }

  it("visibilitychange, focus and same-user auth events keep the typed value", async () => {
    await act(async () => root.render(createElement(SupabaseProvider, null, createElement(ProbeForm))));
    await flush();
    const input = host.querySelector<HTMLInputElement>('[data-testid="probe"]')!;
    await type(input, "Typed value");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      for (const l of auth.listeners) {
        l("SIGNED_IN", { user: { id: "u1" } });
        l("TOKEN_REFRESHED", { user: { id: "u1" } });
        l("INITIAL_SESSION", { user: { id: "u1" } });
      }
    });
    await flush();
    expect(input.value).toBe("Typed value");
    expect(host.querySelector('[data-testid="loads"]')?.textContent).toBe("1");
    // A different user still updates (and the form reloads), and signing out clears saved drafts.
    writeDraft(KEY, { name: "x" });
    await act(async () => {
      for (const l of auth.listeners) l("SIGNED_IN", { user: { id: "u2" } });
    });
    await flush();
    expect(host.querySelector('[data-testid="loads"]')?.textContent).toBe("2");
    await act(async () => {
      for (const l of auth.listeners) l("SIGNED_OUT", null);
    });
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});
