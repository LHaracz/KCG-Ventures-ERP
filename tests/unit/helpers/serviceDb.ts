/**
 * A tiny supabase-js look-alike over PGlite, acting as the service role:
 * enough of from().select/insert/update + eq/not/maybeSingle and rpc() for the
 * server code under test. Errors carry `hint`, like PostgREST.
 */
import type { PGlite } from "@electric-sql/pglite";
import { asService } from "./accessDb";

type Filter = { col: string; op: "eq" | "is_not_null"; val?: unknown };
type Result = { data: any; error: { message: string; hint?: string } | null }; // eslint-disable-line @typescript-eslint/no-explicit-any

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

function asError(e: unknown) {
  const err = e as { message?: string; hint?: string };
  return { message: err.message ?? String(e), hint: err.hint };
}

export function serviceDb(pg: PGlite) {
  class Query implements PromiseLike<Result> {
    private filters: Filter[] = [];
    private op: "select" | "update" | "insert" = "select";
    private cols = "*";
    private values: Record<string, unknown> | Record<string, unknown>[] = {};
    private single = false;
    constructor(private table: string) {}
    select(cols = "*") {
      this.cols = cols;
      return this;
    }
    update(values: Record<string, unknown>) {
      this.op = "update";
      this.values = values;
      return this;
    }
    insert(values: Record<string, unknown> | Record<string, unknown>[]) {
      this.op = "insert";
      this.values = values;
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push({ col, op: "eq", val });
      return this;
    }
    not(col: string, op: string, val: unknown) {
      if (op !== "is" || val !== null) throw new Error("only not(col, 'is', null) is supported");
      this.filters.push({ col, op: "is_not_null" });
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    private where(params: unknown[]) {
      if (!this.filters.length) return "";
      return " where " + this.filters.map((f) => {
        if (f.op === "is_not_null") return `${ident(f.col)} is not null`;
        params.push(f.val);
        return `${ident(f.col)} = $${params.length}`;
      }).join(" and ");
    }
    async run(): Promise<Result> {
      await asService(pg);
      const params: unknown[] = [];
      try {
        let sql: string;
        if (this.op === "select") {
          const cols = this.cols === "*" ? "*" : this.cols.split(",").map((c) => ident(c.trim())).join(", ");
          sql = `select ${cols} from ${ident(this.table)}${this.where(params)}`;
        } else if (this.op === "update") {
          const sets = Object.entries(this.values as Record<string, unknown>).map(([k, v]) => {
            params.push(v);
            return `${ident(k)} = $${params.length}`;
          });
          sql = `update ${ident(this.table)} set ${sets.join(", ")}${this.where(params)} returning *`;
        } else {
          const rows = Array.isArray(this.values) ? this.values : [this.values];
          const keys = Object.keys(rows[0]);
          const tuples = rows.map((r) => "(" + keys.map((k) => {
            const v = r[k];
            params.push(v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);
            return `$${params.length}`;
          }).join(", ") + ")");
          sql = `insert into ${ident(this.table)} (${keys.map(ident).join(", ")}) values ${tuples.join(", ")} returning *`;
        }
        const r = await pg.query(sql, params);
        return { data: this.single ? r.rows[0] ?? null : r.rows, error: null };
      } catch (e) {
        return { data: null, error: asError(e) };
      }
    }
    then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
      return this.run().then(ok, bad);
    }
  }

  return {
    from: (table: string) => new Query(table),
    async rpc(fn: string, args: Record<string, unknown>): Promise<Result> {
      await asService(pg);
      const keys = Object.keys(args);
      const sql = `select ${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")}) as v`;
      try {
        const r = await pg.query<{ v: unknown }>(sql, keys.map((k) => args[k]));
        return { data: r.rows[0]?.v ?? null, error: null };
      } catch (e) {
        return { data: null, error: asError(e) };
      }
    },
  };
}
