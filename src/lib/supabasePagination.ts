// Supabase/PostgREST caps unbounded selects at a default row limit, which
// silently truncates a large table's results to only the first page unless
// you page through it explicitly. This loops with explicit .range() pages
// until a page comes back short, so nothing is ever silently dropped.
//
// Extracted from src/app/sales-data/page.tsx (where it originated) so the
// Stats page and the Markets "Recalculate Market Tags" action can reuse it
// without each keeping its own copy.

const FETCH_PAGE_SIZE = 1000;

export async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  let offset = 0;
  let all: T[] = [];
  while (true) {
    const { data, error } = await build(offset, offset + FETCH_PAGE_SIZE - 1);
    if (error) return { data: all, error };
    const rows = data || [];
    all = all.concat(rows);
    if (rows.length < FETCH_PAGE_SIZE) break;
    offset += FETCH_PAGE_SIZE;
  }
  return { data: all, error: null };
}
