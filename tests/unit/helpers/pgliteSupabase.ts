/**
 * A tiny supabase-js look-alike over PGlite, covering only the query-builder
 * calls the SOP service uses. Lets the service run against the real
 * migration SQL offline. Test helper only.
 */
import type { PGlite } from "@electric-sql/pglite";

type Result = { data: any; error: { message: string } | null };

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

function selectList(cols: string): string {
  return cols
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((item) => {
      let alias: string | null = null;
      let expr = item;
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*):(.+)$/.exec(item);
      if (m) {
        alias = m[1];
        expr = m[2];
      }
      if (expr === "*") return "*";
      let sql: string;
      const arrow = /^([a-zA-Z_][a-zA-Z0-9_]*)->>([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(expr);
      const cast = /^([a-zA-Z_][a-zA-Z0-9_]*)::([a-z]+)$/.exec(expr);
      if (arrow) sql = `${ident(arrow[1])}->>'${arrow[2]}'`;
      else if (cast) sql = `${ident(cast[1])}::${cast[2]}`;
      else sql = ident(expr);
      const name = alias ?? (arrow ? arrow[2] : cast ? cast[1] : expr);
      return `${sql} as ${ident(name)}`;
    })
    .join(", ");
}

function toParam(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return JSON.stringify(v);
  return v;
}

class Query implements PromiseLike<Result> {
  private filters: { sql: string; value?: unknown }[] = [];
  private orderBy: string[] = [];
  private lim: number | null = null;
  private off = 0;
  private cols = "*";
  private mode: "select" | "update" | "insert" = "select";
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private returning: string | null = null;
  private single: "one" | "maybe" | null = null;

  constructor(private db: PGlite, private table: string) {}

  select(cols = "*") {
    if (this.mode === "select") this.cols = cols;
    else this.returning = cols;
    return this;
  }
  update(payload: Record<string, unknown>) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push({ sql: `${ident(col)} = $?`, value });
    return this;
  }
  in(col: string, values: unknown[]) {
    this.filters.push({ sql: `${ident(col)} = any($?)`, value: values });
    return this;
  }
  is(col: string, value: null) {
    this.filters.push({ sql: `${ident(col)} is ${value === null ? "null" : "not null"}` });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push(`${ident(col)} ${opts?.ascending === false ? "desc" : "asc"}`);
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  range(from: number, to: number) {
    this.off = from;
    this.lim = to - from + 1;
    return this;
  }
  maybeSingle() {
    this.single = "maybe";
    return this;
  }
  singleRow() {
    this.single = "one";
    return this;
  }

  private async run(): Promise<Result> {
    const params: unknown[] = [];
    const where = this.filters.length
      ? " where " +
        this.filters
          .map((f) => {
            if (!f.sql.includes("$?")) return f.sql;
            params.push(toParam(f.value));
            return f.sql.replace("$?", `$${params.length}`);
          })
          .join(" and ")
      : "";
    let sql: string;
    if (this.mode === "select") {
      sql = `select ${selectList(this.cols)} from ${ident(this.table)}${where}`;
      if (this.orderBy.length) sql += ` order by ${this.orderBy.join(", ")}`;
      if (this.lim !== null) sql += ` limit ${this.lim}`;
      if (this.off) sql += ` offset ${this.off}`;
    } else if (this.mode === "update") {
      // SET placeholders come first, then the WHERE placeholders.
      const p2: unknown[] = [];
      const setSql = Object.entries(this.payload as Record<string, unknown>).map(([k, v]) => {
        p2.push(toParam(v));
        return `${ident(k)} = $${p2.length}`;
      });
      const whereSql = this.filters
        .map((f) => {
          if (!f.sql.includes("$?")) return f.sql;
          p2.push(toParam(f.value));
          return f.sql.replace("$?", `$${p2.length}`);
        })
        .join(" and ");
      params.length = 0;
      params.push(...p2);
      sql = `update ${ident(this.table)} set ${setSql.join(", ")}${whereSql ? ` where ${whereSql}` : ""}`;
      sql += ` returning ${this.returning ? selectList(this.returning) : "*"}`;
    } else {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const keys = Object.keys(rows[0]);
      const values = rows.map((r) => `(${keys.map((k) => { params.push(toParam(r[k])); return `$${params.length}`; }).join(", ")})`);
      sql = `insert into ${ident(this.table)} (${keys.map(ident).join(", ")}) values ${values.join(", ")} returning ${this.returning ? selectList(this.returning) : "*"}`;
    }
    try {
      const res = await this.db.query(sql, params);
      const rows = res.rows as any[];
      if (this.single === "maybe") return { data: rows[0] ?? null, error: null };
      if (this.single === "one") return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  }

  then<T1 = Result, T2 = never>(ok?: ((v: Result) => T1 | PromiseLike<T1>) | null, err?: ((e: any) => T2 | PromiseLike<T2>) | null) {
    return this.run().then(ok, err);
  }
}

export function pgliteSupabase(db: PGlite) {
  return {
    from(table: string) {
      const q = new Query(db, table);
      // supabase-js uses .single(); map it without clashing with the class field
      (q as any).single = () => q.singleRow();
      return q as any;
    },
    async rpc(fn: string, args: Record<string, unknown>): Promise<Result> {
      const keys = Object.keys(args);
      const params = keys.map((k) => toParam(args[k]));
      const sql = `select ${ident(fn)}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
      try {
        const res = await db.query<{ r: unknown }>(sql, params);
        return { data: res.rows[0]?.r ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    },
    auth: { admin: { getUserById: async () => ({ data: { user: { email: "finalizer@example.com", user_metadata: { full_name: "Test Finalizer" } } } }) } },
  };
}
