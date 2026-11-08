"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { SetPasswordForm } from "@/components/access/SetPasswordForm";

/**
 * Handles the emailed invite or password-reset link, then asks for a new
 * password. Works with the three link shapes Supabase can send:
 *   ?token_hash=…&type=invite|recovery   (recommended email template)
 *   ?code=…                              (PKCE, e.g. a reset requested in this browser)
 *   #access_token=…&refresh_token=…      (Supabase's default templates)
 * Expired or used links go to /auth/invalid-link.
 */
type State = { kind: "checking" } | { kind: "ready"; flow: "invite" | "recovery" } | { kind: "done" };

export default function AcceptInvitePage() {
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    const invalid = () => window.location.replace("/auth/invalid-link");

    (async () => {
      const url = new URL(window.location.href);
      const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
      const flowParam = url.searchParams.get("flow") ?? url.searchParams.get("type") ?? hash.get("type");
      const flow: "invite" | "recovery" = flowParam === "recovery" ? "recovery" : "invite";

      if (hash.get("error") || url.searchParams.get("error") || hash.get("error_code")) return invalid();

      try {
        const tokenHash = url.searchParams.get("token_hash");
        const type = url.searchParams.get("type");
        const code = url.searchParams.get("code");
        if (tokenHash && (type === "invite" || type === "recovery" || type === "magiclink" || type === "email")) {
          const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
          if (error) return invalid();
        } else if (hash.get("access_token") && hash.get("refresh_token")) {
          const { error } = await supabase.auth.setSession({
            access_token: hash.get("access_token")!,
            refresh_token: hash.get("refresh_token")!,
          });
          if (error) return invalid();
        } else if (code) {
          // The client may already have exchanged it on load.
          const { data } = await supabase.auth.getSession();
          if (!data.session) {
            const { error } = await supabase.auth.exchangeCodeForSession(code);
            if (error) return invalid();
          }
        } else {
          const { data } = await supabase.auth.getSession();
          if (!data.session) return invalid();
        }
        // Remove tokens from the address bar.
        window.history.replaceState(null, "", `/auth/accept-invite?flow=${flow}`);

        // Only invited or active employees may continue.
        const { data } = await supabase.auth.getSession();
        const res = await fetch("/api/account/me", { headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` } });
        const me = await res.json().catch(() => ({}));
        if (!res.ok || (me.status !== "invited" && me.status !== "active")) {
          window.location.replace("/no-access");
          return;
        }
        if (!cancelled) setState({ kind: "ready", flow });
      } catch {
        invalid();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center text-black">
      {state.kind === "checking" && <p className="text-sm text-black">Checking your link…</p>}
      {state.kind === "ready" && (
        <SetPasswordForm
          title={state.flow === "recovery" ? "Set a new password" : "Welcome! Choose a password"}
          intro={state.flow === "recovery" ? undefined : "You'll use this password with your email to sign in to the ERP."}
          submitLabel={state.flow === "recovery" ? "Save password" : "Save password and continue"}
          onDone={() => {
            setState({ kind: "done" });
            window.location.replace("/");
          }}
        />
      )}
      {state.kind === "done" && <p className="text-sm text-black">Saved. Opening the ERP…</p>}
    </div>
  );
}
