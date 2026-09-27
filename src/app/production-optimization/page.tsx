"use client";

import { AuthGuard } from "@/components/AuthGuard";

export default function ProductionOptimizationPage() {
  return (
    <AuthGuard>
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Production Optimization
          </h1>
          <p className="text-sm text-black">
            Suggested BotanIQals production quantities based on demand and raw
            material inventory.
          </p>
        </header>
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          This page is coming soon.
        </div>
      </div>
    </AuthGuard>
  );
}
