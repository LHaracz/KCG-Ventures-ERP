"use client";

import Link from "next/link";
import { useState } from "react";
import { SetPasswordForm } from "@/components/access/SetPasswordForm";

/** Change your own password while signed in. */
export default function SetPasswordPage() {
  const [done, setDone] = useState(false);
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center text-black">
      {done ? (
        <div role="status">
          <p className="text-sm text-black">Your password was changed.</p>
          <Link href="/" className="mt-3 inline-block text-sm font-medium text-emerald-700 underline">
            Back to the Dashboard
          </Link>
        </div>
      ) : (
        <SetPasswordForm title="Change your password" onDone={() => setDone(true)} />
      )}
    </div>
  );
}
