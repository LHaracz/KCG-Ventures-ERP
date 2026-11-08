import Link from "next/link";

/** Shown instead of a page the signed-in employee has no feature for. */
export function Forbidden() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-zinc-200 bg-white p-6 text-center text-black shadow-sm" data-testid="forbidden">
      <h1 className="text-lg font-semibold text-black">You don&apos;t have access to this feature</h1>
      <p className="mt-2 text-sm text-black">Ask an admin if you need it.</p>
      <Link href="/" className="mt-4 inline-block rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
        Go to the Dashboard
      </Link>
    </div>
  );
}
