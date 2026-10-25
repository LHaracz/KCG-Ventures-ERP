import { AuthGuard } from "@/components/AuthGuard";

export default function ComplianceLogsPage() {
  return (
    <AuthGuard>
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold text-zinc-900">Logs</h1>
        <p className="mt-2 text-sm text-black">Logs coming soon.</p>
      </div>
    </AuthGuard>
  );
}
